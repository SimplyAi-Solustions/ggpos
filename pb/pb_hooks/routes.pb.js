/// <reference path="../pb_data/types.d.ts" />

/**
 * routes.pb.js - custom /api/vault/* routes.
 *
 * Both routes require a "staff" auth token; $apis.requireAuth returns 401
 * when there is none at all (asserted by pb/scripts/check.sh).
 *
 * Each registered handler runs in its own isolated goja context, so
 * nothing here reaches outside its own handler function for state or
 * helpers (verified against v0.40.4: a top-level const referenced from a
 * routerAdd handler threw "ReferenceError: ... is not defined" at request
 * time even though it registered and started up without complaint) - see
 * pb/README.md.
 */

// GET /api/vault/health: liveness/ops snapshot for staff.
routerAdd(
  "GET",
  "/api/vault/health",
  (e) => {
    // Tracks the pinned PocketBase version (pb/scripts/dev.sh,
    // pb/Dockerfile's PB_VERSION build arg). There is no JS-exposed
    // runtime version getter, so this is a plain literal rather than a
    // live lookup - bump it alongside those two when the pin changes.
    return e.json(200, {
      status: "ok",
      version: "0.40.4",
      counts: {
        items: e.app.countRecords("items"),
        customers: e.app.countRecords("customers"),
        staff: e.app.countRecords("staff"),
        sales: e.app.countRecords("sales"),
        trade_ins: e.app.countRecords("trade_ins"),
      },
    });
  },
  $apis.requireAuth("staff")
);

// GET /api/vault/me: the caller's own record. For staff, the same
// hand-picked shape as always (pin_hash can never leak even if the schema
// grows more sensitive fields later - this does not just strip a
// deny-list). For a customer, the Phase 5 portal summary
// (docs/api-contract.md's Phase 5 section): balances summed live from the
// ledgers, tier, id_status, and per-area counts, built once in
// lib/vaultutil.js's meShapeFor so this route, PATCH /api/vault/me
// (portal.pb.js) and GET /api/vault/c/:token can never disagree on the
// shape. One registration, not two: PocketBase's router refuses a second
// handler on the same method and path outright, so the customer branch
// lives here rather than in a route of its own in portal.pb.js.
routerAdd(
  "GET",
  "/api/vault/me",
  (e) => {
    const auth = e.auth;
    if (auth.collection().name === "customers") {
      const util = require(`${__hooks}/lib/vaultutil.js`);
      return e.json(200, util.meShapeFor(e.app, auth));
    }
    const staff = auth;
    return e.json(200, {
      id: staff.id,
      name: staff.getString("name"),
      role: staff.getString("role"),
      active: staff.getBool("active"),
      created: staff.getString("created"),
      updated: staff.getString("updated"),
    });
  },
  $apis.requireAuth("staff", "customers")
);
