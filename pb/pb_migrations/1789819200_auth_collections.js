/// <reference path="../pb_data/types.d.ts" />

/**
 * Auth collections: staff (counter login) and customers (portal login),
 * plus the staff-only PII split for customers (customer_private, id_documents).
 *
 * See docs/PLAN.md, "Data model (PocketBase collections) > Auth".
 *
 * Rule conventions used throughout every migration in this project:
 *   - staff-only:  @request.auth.collectionName = "staff"
 *   - admin-only:  @request.auth.collectionName = "staff" && @request.auth.role = "admin"
 *   - customer-own: <relation field> = @request.auth.id (or id = @request.auth.id on customers itself)
 *   - null means superuser (server code via $app) only.
 */
migrate((app) => {
  const STAFF_ONLY = '@request.auth.collectionName = "staff"';
  const ADMIN_ONLY = '@request.auth.collectionName = "staff" && @request.auth.role = "admin"';

  // ---------------------------------------------------------------------
  // staff: counter login. Password auth, MFA optional (opt-in per user,
  // not forced), OTP off. Fully admin-gated: ordinary staff read their own
  // record through the custom GET /api/vault/me route (pb_hooks/routes.pb.js)
  // rather than the raw collection, matching "admin role for ... staff" in
  // PLAN.md's "API rules in short".
  // ---------------------------------------------------------------------
  const staff = new Collection({
    name: "staff",
    type: "auth",
    listRule: ADMIN_ONLY,
    viewRule: ADMIN_ONLY,
    createRule: ADMIN_ONLY,
    updateRule: ADMIN_ONLY,
    deleteRule: ADMIN_ONLY,
    passwordAuth: { enabled: true },
    otp: { enabled: false },
    // PLAN.md asks for "MFA optional" on staff, but PocketBase's MFA is
    // literally "pass two of your enabled auth methods in sequence", so it
    // refuses enabled:true while only one method (password) is on - see
    // pb/README.md. Left off here; flip to true (and turn on a second
    // method such as OTP or OAuth2) once a real second factor exists.
    mfa: { enabled: false },
    fields: [
      { name: "name", type: "text", required: true, max: 200 },
      { name: "role", type: "select", required: true, maxSelect: 1, values: ["admin", "staff"] },
      { name: "active", type: "bool" },
      // Hash only; the 4-6 digit PIN itself is never stored or returned.
      { name: "pin_hash", type: "text", max: 200 },
      { name: "created", type: "autodate", onCreate: true },
      { name: "updated", type: "autodate", onCreate: true, onUpdate: true },
    ],
  });
  app.save(staff);

  // ---------------------------------------------------------------------
  // customers: portal login, OTP only (no password). Only fields the
  // customer themself may see and edit live here; everything sensitive
  // lives on customer_private instead (PocketBase rules are per record,
  // not per field).
  // ---------------------------------------------------------------------
  const customers = new Collection({
    name: "customers",
    type: "auth",
    listRule: STAFF_ONLY,
    viewRule: `${STAFF_ONLY} || id = @request.auth.id`,
    // Staff create customers at the counter (customers.pb.js assigns the
    // code and a random password on this same create request).
    createRule: STAFF_ONLY,
    // A customer may edit their own contact details and consent, never the
    // code, QR token, referral or source that staff and hooks own.
    updateRule: `${STAFF_ONLY} || (id = @request.auth.id && @request.body.code:isset = false && @request.body.qr_token:isset = false && @request.body.referred_by:isset = false && @request.body.source:isset = false)`,
    deleteRule: ADMIN_ONLY,
    passwordAuth: { enabled: false },
    otp: { enabled: true, duration: 300, length: 8 },
    mfa: { enabled: false },
    fields: [
      // Overrides the auto-added system email field to make it optional:
      // PLAN.md is explicit that "a customer with no email on file has no
      // portal until one is added", so a walk-in customer can be created
      // with just a name and/or phone. Declaring it here (still
      // type: "email", still the recognised auth field) is confirmed to
      // override PocketBase's own default of required: true for it.
      { name: "email", type: "email", required: false },
      { name: "name", type: "text", required: true, max: 200 },
      { name: "phone", type: "text", max: 32 }, // E.164
      { name: "code", type: "text", max: 32 }, // unique GGC-xxxxx, see customers.pb.js
      { name: "qr_token", type: "text", max: 64 }, // rotatable, encodes /c/:token
      { name: "marketing_consent", type: "bool" },
      { name: "birthday_month", type: "number", onlyInt: true, min: 1, max: 12 },
      { name: "source", type: "select", maxSelect: 1, values: ["counter", "portal"] },
      // Self relation: patched in after this collection is saved so we can
      // pass its own collection id (see below).
      { name: "created", type: "autodate", onCreate: true },
      { name: "updated", type: "autodate", onCreate: true, onUpdate: true },
    ],
  });
  app.save(customers);

  // customers.referred_by is a self-relation, so the target collection id
  // (its own) is only known once the collection above has been saved once.
  customers.fields.add(
    new Field({
      name: "referred_by",
      type: "relation",
      collectionId: customers.id,
      maxSelect: 1,
      cascadeDelete: false,
    })
  );
  customers.addIndex("idx_customers_code_unique", true, "code", "");
  customers.addIndex("idx_customers_qr_token_unique", true, "qr_token", "");
  app.save(customers);

  // ---------------------------------------------------------------------
  // customer_private: staff-only 1:1 extension of customers. Address,
  // ID/KYC status, cached credit and points balances (ledgers are the
  // source of truth), tier.
  // ---------------------------------------------------------------------
  const customerPrivate = new Collection({
    name: "customer_private",
    type: "base",
    listRule: STAFF_ONLY,
    viewRule: STAFF_ONLY,
    createRule: STAFF_ONLY,
    updateRule: STAFF_ONLY,
    deleteRule: ADMIN_ONLY,
    fields: [
      {
        name: "customer",
        type: "relation",
        required: true,
        collectionId: customers.id,
        maxSelect: 1,
        cascadeDelete: true,
      },
      { name: "address", type: "text", max: 1000 }, // required before any cash buy-in (enforced in the trade-in route)
      { name: "dob", type: "date" },
      { name: "notes", type: "editor" },
      {
        name: "flags",
        type: "select",
        maxSelect: 3,
        values: ["no_cash", "watchlist", "under_18"],
      },
      {
        name: "id_status",
        type: "select",
        maxSelect: 1,
        values: ["none", "verified", "expired", "rejected"],
      },
      { name: "id_type", type: "text", max: 100 },
      { name: "id_expiry", type: "date" },
      { name: "id_ref_last4", type: "text", max: 4 },
      { name: "id_verified_by", type: "relation", collectionId: staff.id, maxSelect: 1 },
      { name: "id_verified_at", type: "date" },
      // Cached; credit_ledger / points_ledger are the append-only truth.
      { name: "credit_balance", type: "number", onlyInt: true },
      { name: "points_balance", type: "number", onlyInt: true },
      // loyalty_tiers does not exist yet at this point in the migration
      // sequence, so this relation is patched on in 1789819500_loyalty_collections.js.
      { name: "created", type: "autodate", onCreate: true },
      { name: "updated", type: "autodate", onCreate: true, onUpdate: true },
    ],
  });
  customerPrivate.addIndex("idx_customer_private_customer_unique", true, "customer", "");
  app.save(customerPrivate);

  // ---------------------------------------------------------------------
  // id_documents: encrypted ID photos. All rules null (superuser only) so
  // reads and writes only ever happen through custom routes, never the
  // raw collection API.
  // ---------------------------------------------------------------------
  const idDocuments = new Collection({
    name: "id_documents",
    type: "base",
    listRule: null,
    viewRule: null,
    createRule: null,
    updateRule: null,
    deleteRule: null,
    fields: [
      {
        name: "customer",
        type: "relation",
        required: true,
        collectionId: customers.id,
        maxSelect: 1,
        cascadeDelete: false,
      },
      // Encrypted with $security.encrypt before saving; never served directly.
      { name: "photo", type: "file", maxSelect: 1, maxSize: 15728640, protected: true },
      { name: "taken_by", type: "relation", collectionId: staff.id, maxSelect: 1 },
      { name: "taken_at", type: "date" },
      { name: "expires_at", type: "date" },
      { name: "created", type: "autodate", onCreate: true },
      { name: "updated", type: "autodate", onCreate: true, onUpdate: true },
    ],
  });
  app.save(idDocuments);
}, (app) => {
  app.delete(app.findCollectionByNameOrId("id_documents"));
  app.delete(app.findCollectionByNameOrId("customer_private"));
  app.delete(app.findCollectionByNameOrId("customers"));
  app.delete(app.findCollectionByNameOrId("staff"));
});
