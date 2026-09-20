/// <reference path="../pb_data/types.d.ts" />

/**
 * Phase 5 (portal, quotes, want lists, estimate and notifications): schema
 * for the message thread on a quote, the settings the new routes need, and
 * three rule changes.
 *
 * See docs/api-contract.md's Phase 5 section for the routes this supports.
 *
 * Added:
 *  - `quote_messages`: the two-way thread on a quote
 *    (POST /api/vault/quotes/:id/messages). Staff have full access;
 *    a customer may list, view and create on their own quote only
 *    (never update or delete - the thread is an append-only record of what
 *    was said, the same reasoning credit_ledger and points_ledger are
 *    append-only). A customer's own create is further narrowed to their own
 *    author_kind and customer id, so they cannot post a message that reads
 *    as if it came from staff.
 *  - `settings.push`: `{ vapid_public_key: "" }` - the public half of the
 *    Web Push VAPID keypair, served to the portal by `GET /api/vault/config`
 *    (config.pb.js). Empty until deploy generates a real keypair and sets
 *    it (deploy/README.md); the private half never touches this settings
 *    row at all - it lives only in services/notify's own environment
 *    (GG_VAPID_PRIVATE_KEY), never in pb_data and never returned by any
 *    route.
 *  - `customers.notify_email` / `.notify_push` (default true, set by
 *    customers.pb.js's own create hook): the portal's own opt-outs
 *    (`PATCH /api/vault/me`'s `notifications: { email, push }`), which the
 *    Phase 5 route contract accepts as input but does not otherwise give a
 *    field to live in - lib/notify.js honours `notify_email` before
 *    emailing a customer, and services/notify honours `notify_push` before
 *    sending a push to one. Not part of any customer's own PII: this is a
 *    delivery preference, not a contact detail.
 *  - `settings.holds`: `{ hours: 48 }` - how long a want-list match holds
 *    the item before the holds_release cron puts it back (docs/PLAN.md,
 *    "Want lists": "a 48-hour hold").
 *  - `quotes.closed_at`: stamped by a small onRecordUpdate hook in
 *    quotes.pb.js the moment `status` first becomes `completed`, `declined`
 *    or `expired` (the same shape as `items.listed_at` in items.pb.js), so
 *    the quote_photos_retention cron can tell "closed 90 days ago" from
 *    "merely not updated in 90 days" - `updated` moves on a later reply or
 *    any other touch, which `closed_at` never does once set. pb/README.md
 *    (Phase 4's retention cron section) named this the reason quote photos
 *    were not purged yet; this is that field.
 *
 * Changed:
 *  - `want_list.updateRule` gains a customer-own carve-out: a customer may
 *    set `status` to `"closed"` on their own row and touch nothing else
 *    (POST /api/vault/want-list/:id/close, wants.pb.js) - staff keep full
 *    access as before.
 *  - `customers.otp.emailTemplate`: PocketBase's own default OTP email
 *    ("OTP for {APP_NAME}" / "Your one-time password is: ...") is replaced
 *    with a GG-branded subject and a plain-text body naming the code and
 *    how long it lasts, matching CLAUDE.md's copy rules (no exclamation
 *    marks, no emoji, short and specific).
 *  - `app.settings().rateLimits`: three rules for the two public estimate
 *    routes (no auth, so IP is the only throttle available) and the OTP
 *    request every customer's first sign-in and every subsequent one goes
 *    through (docs/PLAN.md, "Security, GDPR and record keeping": "rate
 *    limits on ... customers:requestOTP and /api/vault/*"). PocketBase's
 *    rate limiter is a real, general setting (confirmed against this
 *    binary's own `RateLimitsConfig`/`RateLimitRule` - see pb/README.md's
 *    Phase 5 notes), so this is not a "say so if not" case.
 *
 * Not changed here: `quotes.createRule` stays as Phase 2 left it (staff, or
 * a customer creating their own row directly) rather than tightening to
 * staff-only as the Phase 5 brief describes ("customers submit through the
 * route"). Tightening it would refuse pb/scripts/check.sh's own section 8
 * (`POST /api/collections/quotes/records` as a customer token, part of the
 * sections this round leaves alone), so the new `POST /api/vault/quotes`
 * route (quotes.pb.js) is additive: it is the documented way a real photo
 * upload happens, but the collection itself is not narrowed. See this
 * package's report for the full note.
 */
migrate(
  (app) => {
    const STAFF_ONLY = '@request.auth.collectionName = "staff"';
    const autodates = () => [
      { name: "created", type: "autodate", onCreate: true },
      { name: "updated", type: "autodate", onCreate: true, onUpdate: true },
    ];

    const quotes = app.findCollectionByNameOrId("quotes");
    const customers = app.findCollectionByNameOrId("customers");
    const staff = app.findCollectionByNameOrId("staff");

    quotes.fields.add(new Field({ name: "closed_at", type: "date" }));
    app.save(quotes);

    customers.fields.add(new Field({ name: "notify_email", type: "bool" }));
    customers.fields.add(new Field({ name: "notify_push", type: "bool" }));
    app.save(customers);
    // Existing customers opt in by default, same as a freshly-created one
    // (customers.pb.js's own onRecordCreate hook defaults a new row the
    // same way) - Phase 5 must not silently go quiet for anyone already on
    // file.
    let existingCustomers = [];
    try {
      existingCustomers = app.findRecordsByFilter("customers", "id != ''", "", 0, 0);
    } catch (err) {
      existingCustomers = [];
    }
    for (let i = 0; i < existingCustomers.length; i++) {
      const c = existingCustomers[i];
      if (!c) continue;
      c.set("notify_email", true);
      c.set("notify_push", true);
      app.save(c);
    }

    // ---------------------------------------------------------------------
    // quote_messages
    // ---------------------------------------------------------------------
    const quoteMessages = new Collection({
      name: "quote_messages",
      type: "base",
      listRule: `${STAFF_ONLY} || quote.customer = @request.auth.id`,
      viewRule: `${STAFF_ONLY} || quote.customer = @request.auth.id`,
      createRule:
        `${STAFF_ONLY} || (@request.auth.collectionName = "customers" && quote.customer = @request.auth.id && ` +
        `customer = @request.auth.id && author_kind = "customer" && @request.body.staff:isset = false)`,
      // Append-only: nobody edits or removes a line of a conversation once
      // sent, the same reasoning the append-only ledgers use.
      updateRule: null,
      deleteRule: null,
      fields: [
        { name: "quote", type: "relation", required: true, collectionId: quotes.id, maxSelect: 1, cascadeDelete: true },
        {
          name: "author_kind",
          type: "select",
          required: true,
          maxSelect: 1,
          values: ["customer", "staff"],
        },
        { name: "customer", type: "relation", collectionId: customers.id, maxSelect: 1 },
        { name: "staff", type: "relation", collectionId: staff.id, maxSelect: 1 },
        { name: "body", type: "text", required: true, max: 2000 },
        ...autodates(),
      ],
    });
    app.save(quoteMessages);

    // ---------------------------------------------------------------------
    // want_list.updateRule: a customer may close their own row and nothing
    // else on it.
    // ---------------------------------------------------------------------
    const wantList = app.findCollectionByNameOrId("want_list");
    wantList.updateRule =
      `${STAFF_ONLY} || (@request.auth.collectionName = "customers" && customer = @request.auth.id && ` +
      `@request.body.status = "closed" && @request.body.customer:isset = false && ` +
      `@request.body.card:isset = false && @request.body.free_text:isset = false && ` +
      `@request.body.max_price:isset = false && @request.body.matched_item:isset = false && ` +
      `@request.body.notified_at:isset = false)`;
    app.save(wantList);

    // ---------------------------------------------------------------------
    // settings.push / settings.holds
    // ---------------------------------------------------------------------
    const settings = app.findCollectionByNameOrId("settings");
    settings.fields.add(new Field({ name: "push", type: "json", maxSize: 2000 }));
    settings.fields.add(new Field({ name: "holds", type: "json", maxSize: 2000 }));
    app.save(settings);

    let settingsRow = null;
    try {
      settingsRow = app.findFirstRecordByFilter("settings", "id != ''");
    } catch (err) {
      settingsRow = null; // no settings row yet (fresh, pre-seed database)
    }
    if (settingsRow) {
      settingsRow.set("push", { vapid_public_key: "" });
      settingsRow.set("holds", { hours: 48 });
      app.save(settingsRow);
    }

    // ---------------------------------------------------------------------
    // customers.otp.emailTemplate: a GG subject and a plain body naming the
    // code and how long it lasts, replacing PocketBase's own generic default.
    // ---------------------------------------------------------------------
    customers.otp.emailTemplate.subject = "Your GG Vault code";
    customers.otp.emailTemplate.body = "Your GG Vault code is {OTP}. It works for five minutes.";
    app.save(customers);

    // ---------------------------------------------------------------------
    // Rate limits: the two public estimate routes (guests only, by IP - the
    // one throttle available with no token) and the OTP request every
    // customer sign-in goes through. Values are generous enough that a
    // legitimate customer, or pb/scripts/check.sh's own handful of calls,
    // never trips them, while still stopping a scraping or guessing loop.
    // ---------------------------------------------------------------------
    const rl = app.settings();
    rl.rateLimits.enabled = true;
    rl.rateLimits.rules.push(
      { label: "customers:requestOTP", audience: "@guest", duration: 300, maxRequests: 20 },
      { label: "GET /api/vault/estimate/search", audience: "@guest", duration: 60, maxRequests: 60 },
      { label: "GET /api/vault/estimate", audience: "@guest", duration: 60, maxRequests: 60 }
    );
    app.save(rl);
  },
  (app) => {
    const rl = app.settings();
    const dropLabels = [
      "customers:requestOTP",
      "GET /api/vault/estimate/search",
      "GET /api/vault/estimate",
    ];
    rl.rateLimits.rules = (rl.rateLimits.rules || []).filter((r) => dropLabels.indexOf(r.label) < 0);
    app.save(rl);

    const customers = app.findCollectionByNameOrId("customers");
    customers.otp.emailTemplate.subject = "OTP for {APP_NAME}";
    customers.otp.emailTemplate.body =
      "<p>Hello,</p>\n<p>Your one-time password is: <strong>{OTP}</strong></p>\n<p><i>If you didn't ask for the one-time password, you can ignore this email.</i></p>\n<p>\n  Thanks,<br/>\n  {APP_NAME} team\n</p>";
    app.save(customers);

    let settingsRow = null;
    try {
      settingsRow = app.findFirstRecordByFilter("settings", "id != ''");
    } catch (err) {
      settingsRow = null;
    }
    if (settingsRow) {
      settingsRow.set("push", null);
      settingsRow.set("holds", null);
      app.save(settingsRow);
    }

    const settings = app.findCollectionByNameOrId("settings");
    settings.fields.removeByName("holds");
    settings.fields.removeByName("push");
    app.save(settings);

    const wantList = app.findCollectionByNameOrId("want_list");
    wantList.updateRule = '@request.auth.collectionName = "staff"';
    app.save(wantList);

    app.delete(app.findCollectionByNameOrId("quote_messages"));

    const quotes = app.findCollectionByNameOrId("quotes");
    quotes.fields.removeByName("closed_at");
    app.save(quotes);

    customers.fields.removeByName("notify_push");
    customers.fields.removeByName("notify_email");
    app.save(customers);
  }
);
