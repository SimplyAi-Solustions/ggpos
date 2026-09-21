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
 *  - `customers.otp.emailTemplate`: PocketBase's own default OTP email
 *    ("OTP for {APP_NAME}" / "Your one-time password is: ...") is replaced
 *    with a GG-branded subject and a plain-text body naming the code and
 *    how long it lasts, matching CLAUDE.md's copy rules (no exclamation
 *    marks, no emoji, short and specific).
 *  - `app.settings().rateLimits`: four rules - the two public estimate
 *    routes (no auth, so IP is the only throttle available), the OTP
 *    request every customer's first sign-in and every subsequent one goes
 *    through (docs/PLAN.md, "Security, GDPR and record keeping": "rate
 *    limits on ... customers:requestOTP and /api/vault/*"), and a per-IP
 *    `*:auth` brute-force guard sized for this deploy's own one shared
 *    Caddy IP rather than PocketBase's own tighter bundled default (fix
 *    round, finding 4 - see below). PocketBase's rate limiter is a real,
 *    general setting (confirmed against this binary's own
 *    `RateLimitsConfig`/`RateLimitRule` - see pb/README.md's Phase 5
 *    notes), so this is not a "say so if not" case.
 *  - `app.settings().trustedProxy`: set so a rate limit, and every
 *    `e.realIP()` call elsewhere in `pb_hooks`, reads the real client
 *    address this deploy's own Caddy forwards, not Caddy's own address
 *    shared by every visitor (fix round, finding 4 - see below).
 *  - `quotes.createRule` tightened to staff-only (fix round, finding 1 -
 *    see below).
 *  - `settings.push_vapid_public_key` / `.push_vapid_private_key`
 *    (`1789819560_ops_collections.js`'s own unused Phase 1 fields)
 *    removed: nothing ever read either one, and `settings.push` above is
 *    now the public half's one home (fix round, finding 16, the
 *    orchestrator's own - see below).
 *
 * `quotes.createRule` is tightened to staff-only (fix round, finding 1): a
 * customer's own token could otherwise create a `quotes` row directly with
 * any `status`, `lines` and `offer_total` it liked - `received` copies
 * those lines into a draft trade-in exactly as given, and completion pays
 * them out, so a forged `accepted` row with priced lines was a real path to
 * money. Customers now submit only through `POST /api/vault/quotes`
 * (quotes.pb.js), which always creates `submitted` with empty lines and a
 * zero total; `pb/scripts/check.sh` section 8's own customer-create
 * assertion was updated to expect this 403 (see the report for the fix
 * round). The update rule is untouched: a customer may still reply, accept
 * or decline their own quote through the collection API, guarded by its
 * own `:isset = false` clauses exactly as before.
 *
 * `want_list.updateRule` is NOT given the customer-own-close carve-out an
 * earlier draft of this migration added (fix round, finding 11): a
 * declarative API rule can only ever affect the one collection a request
 * writes to, so it cannot also put a matched `items` row back in stock as
 * part of that same write - only a route can. `POST /api/vault/want-list/
 * :id/close` (wants.pb.js) is therefore the only way a customer closes
 * their own row, and it does the item release itself, in the same
 * transaction. `want_list.updateRule` stays exactly as
 * `1789819320_stock_collections.js` left it (staff only).
 *
 * `app.settings().rateLimits` is set explicitly (fix round, finding 4),
 * not merely turned on: `rateLimits.enabled = true` on its own also
 * activates PocketBase's own bundled default rules (`*:auth` 2 requests /
 * 3 seconds, `*:create` 20/5s, `/api/batch` 3/1s, `/api/*` 300/10s) for
 * every caller behind this deploy's one Caddy IP (deploy/README.md), which
 * is far tighter than this shop's own three rules were ever reviewed
 * against. `rateLimits.rules` is replaced outright with only what this
 * app actually wants: the three rules below, plus a per-IP `*:auth` rule
 * at a level a genuine brute-force loop still trips but a shop's own
 * traffic behind one shared IP does not. `app.settings().trustedProxy` is
 * set alongside it so a rate limit (and `e.realIP()` everywhere else in
 * this codebase) is keyed on the caller's own address forwarded by this
 * deploy's Caddy, not on Caddy's own proxy IP shared by every visitor -
 * see deploy/README.md's Caddy section for the header this expects Caddy
 * to already send.
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
    // quotes.createRule: staff only from here (fix round, finding 1) - see
    // this file's own header comment for why. down() restores the exact
    // expression 1789819380_trading_collections.js originally gave it.
    // ---------------------------------------------------------------------
    quotes.createRule = STAFF_ONLY;
    app.save(quotes);

    // ---------------------------------------------------------------------
    // settings.push / settings.holds. The Phase 1 migration's own
    // push_vapid_public_key / push_vapid_private_key text fields
    // (1789819560_ops_collections.js) are removed in the same breath (fix
    // round, finding 16, the orchestrator's own): nothing has ever read
    // either one, and settings.push.vapid_public_key above is now the
    // public half's one home. The private half never gets a settings field
    // at all, on either name - it lives only in services/notify's own
    // GG_VAPID_PRIVATE_KEY environment variable and always has.
    // ---------------------------------------------------------------------
    const settings = app.findCollectionByNameOrId("settings");
    settings.fields.add(new Field({ name: "push", type: "json", maxSize: 2000 }));
    settings.fields.add(new Field({ name: "holds", type: "json", maxSize: 2000 }));
    settings.fields.removeByName("push_vapid_public_key");
    settings.fields.removeByName("push_vapid_private_key");
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
    // one throttle available with no token), the OTP request every
    // customer sign-in goes through, and a per-IP auth brute-force guard.
    // Values are generous enough that a legitimate customer, or
    // pb/scripts/check.sh's own handful of calls, never trips them, while
    // still stopping a scraping or guessing loop.
    //
    // `rateLimits.rules` is assigned outright, not pushed onto (fix round,
    // finding 4): `rateLimits.enabled = true` alone also activates every
    // one of PocketBase's own bundled default rules (`*:auth` 2 requests /
    // 3 seconds, `*:create` 20/5s, `/api/batch` 3/1s, `/api/*` 300/10s),
    // which were never reviewed against this shop's own one shared Caddy
    // IP and are far tighter than this app actually wants - `*:auth` at
    // 2/3s in particular would fail ordinary counter use within a minute
    // of two staff signing in close together. The four rules below are
    // the complete, deliberate list; nothing else is enabled.
    // ---------------------------------------------------------------------
    const rl = app.settings();
    rl.rateLimits.enabled = true;
    rl.rateLimits.rules = [
      { label: "customers:requestOTP", audience: "@guest", duration: 300, maxRequests: 20 },
      { label: "GET /api/vault/estimate/search", audience: "@guest", duration: 60, maxRequests: 60 },
      { label: "GET /api/vault/estimate", audience: "@guest", duration: 60, maxRequests: 60 },
      // A real brute-force loop still trips this well inside a minute; a
      // shop's own traffic (counter staff signing in, a customer's OTP
      // request/claim, pb/scripts/check.sh's own many logins across its
      // whole run) never does, all sharing this one deploy's Caddy IP.
      // `audience: ""` matches PocketBase's own shipped default for this
      // exact label (confirmed against a freshly started, unmigrated
      // instance's own `/api/settings`) rather than this app's own
      // `"@guest"` convention used above - every `*:auth` route is
      // necessarily pre-authentication anyway, so there is no
      // authenticated-caller case for an audience to narrow.
      { label: "*:auth", audience: "", duration: 60, maxRequests: 10 },
    ];
    app.save(rl);

    // ---------------------------------------------------------------------
    // settings.trustedProxy: without this, every rate limit above (and
    // every e.realIP() call elsewhere in pb_hooks) sees this deploy's own
    // Caddy as the caller, the same one address for every visitor to the
    // shop's site (deploy/README.md's Caddy section) - a limit "per IP"
    // would then really mean "shared by the whole shop's traffic through
    // one proxy", tripping for one visitor because of another entirely.
    // Caddy already sends the real client address on X-Forwarded-For by
    // default; this just tells PocketBase to trust and read it back off
    // that one deploy's own reverse proxy, not off the leftmost (client-
    // supplied, spoofable) entry a chain of untrusted proxies would need
    // instead.
    // ---------------------------------------------------------------------
    rl.trustedProxy = { headers: ["X-Forwarded-For"], useLeftmostIP: false };
    app.save(rl);
  },
  (app) => {
    // Restored to PocketBase's own factory defaults, confirmed against a
    // freshly started, unmigrated instance's own /api/settings (fix round,
    // finding 4) - not derived by filtering this migration's own rules back
    // out of whatever is live, which would lose the bundled defaults
    // `up()`'s wholesale rules assignment replaced rather than appended to.
    const rl = app.settings();
    rl.rateLimits.enabled = false;
    rl.rateLimits.rules = [
      { label: "*:auth", audience: "", duration: 3, maxRequests: 2 },
      { label: "*:create", audience: "", duration: 5, maxRequests: 20 },
      { label: "/api/batch", audience: "", duration: 1, maxRequests: 3 },
      { label: "/api/", audience: "", duration: 10, maxRequests: 300 },
    ];
    rl.trustedProxy = { headers: [], useLeftmostIP: false };
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
      settingsRow.set("push_vapid_public_key", "");
      settingsRow.set("push_vapid_private_key", "");
      app.save(settingsRow);
    }

    const settings = app.findCollectionByNameOrId("settings");
    settings.fields.removeByName("holds");
    settings.fields.removeByName("push");
    // Re-added exactly as 1789819560_ops_collections.js originally defined
    // them (fix round, finding 16, the orchestrator's own).
    settings.fields.add(new Field({ name: "push_vapid_public_key", type: "text", max: 500 }));
    settings.fields.add(new Field({ name: "push_vapid_private_key", type: "text", max: 500 }));
    app.save(settings);

    app.delete(app.findCollectionByNameOrId("quote_messages"));

    const quotes = app.findCollectionByNameOrId("quotes");
    quotes.fields.removeByName("closed_at");
    // The exact original expression from 1789819380_trading_collections.js
    // - STAFF_ONLY is up()'s own local const, not visible here, so this is
    // the same literal written out in full rather than referencing it.
    quotes.createRule =
      '@request.auth.collectionName = "staff" || (@request.auth.collectionName = "customers" && customer = @request.auth.id)';
    app.save(quotes);

    customers.fields.removeByName("notify_push");
    customers.fields.removeByName("notify_email");
    app.save(customers);
  }
);
