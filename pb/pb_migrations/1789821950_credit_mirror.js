/// <reference path="../pb_data/types.d.ts" />

/**
 * credit_mirror: a read-only copy of each customer's store credit balance
 * for the My Vault wallet card. Epos Now is the till and the source of
 * truth; a job on the shop Mac (Gandalf's) will write one row per customer
 * here. The Vault never computes or adjusts a balance - if the mirror is
 * missing or stale the wallet says to ask at the counter.
 *
 * Write access is superusers (or a service token) only. A customer can read
 * their own row and nothing else.
 *
 * wallet_keys holds the HMAC secret the wallet QR tokens are signed with
 * (pb_hooks/binders_wallet.pb.js makes one row on first use). Superusers
 * only, so the staff scanner (also Gandalf's, later) can read the same key.
 */
migrate(
  (app) => {
    const customers = app.findCollectionByNameOrId("customers");

    const mirror = new Collection({
      name: "credit_mirror",
      type: "base",
      listRule: '@request.auth.collectionName = "customers" && customer = @request.auth.id',
      viewRule: '@request.auth.collectionName = "customers" && customer = @request.auth.id',
      createRule: null,
      updateRule: null,
      deleteRule: null,
      fields: [
        {
          type: "relation",
          name: "customer",
          required: true,
          collectionId: customers.id,
          maxSelect: 1,
          cascadeDelete: true,
        },
        // GBP pence, as everywhere in the Vault. "balance_minor" on purpose:
        // the binder price-stripping regex must not eat the one money figure
        // a customer is allowed to see.
        { type: "number", name: "balance_minor", onlyInt: true },
        // When the balance was read from Epos Now, set by the writer.
        { type: "date", name: "balance_at" },
        { type: "text", name: "source", max: 60 },
        { type: "autodate", name: "created", onCreate: true },
        { type: "autodate", name: "updated", onCreate: true, onUpdate: true },
      ],
    });
    mirror.addIndex("idx_credit_mirror_customer_unique", true, "customer", "");
    app.save(mirror);

    const keys = new Collection({
      name: "wallet_keys",
      type: "base",
      listRule: null,
      viewRule: null,
      createRule: null,
      updateRule: null,
      deleteRule: null,
      fields: [
        { type: "text", name: "purpose", required: true, max: 40 },
        { type: "text", name: "secret", required: true, max: 200 },
        { type: "autodate", name: "created", onCreate: true },
      ],
    });
    keys.addIndex("idx_wallet_keys_purpose_unique", true, "purpose", "");
    app.save(keys);
  },
  (app) => {
    app.delete(app.findCollectionByNameOrId("credit_mirror"));
    app.delete(app.findCollectionByNameOrId("wallet_keys"));
  }
);
