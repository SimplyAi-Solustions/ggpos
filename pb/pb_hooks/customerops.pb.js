/// <reference path="../pb_data/types.d.ts" />

/**
 * customerops.pb.js - the three customer record operations that cannot go
 * through the collection API.
 *
 *   GET  /api/vault/customers/{id}/id-document          (staff)
 *   POST /api/vault/customers/{id}/merge                (staff, step-up)
 *   POST /api/vault/customers/{id}/erase                (admin, step-up)
 *
 * `id_documents` has every rule null (superuser only), so the counter app has
 * no way to learn whether a customer has a photo on file; the first route is
 * that lookup, and it never returns the photo or anything off it but its own
 * timestamps.
 *
 * Merge folds a duplicate customer into the one being kept, re-pointing every
 * relation inside one transaction so no ledger row, buy-in or voucher is left
 * behind. Erase is the UK GDPR Article 17 request: the person's own details
 * go, and the buy-in register, sales and ledgers stay, because Article
 * 17(3)(b) keeps a record the shop is required by law to hold. The seller
 * snapshot on a completed trade-in is part of that record and is not touched.
 *
 * Each registered handler runs in its own isolated goja context, so every
 * require() and helper lives inside the handler body - see pb/README.md.
 */

// ---------------------------------------------------------------------
// GET /api/vault/customers/{id}/id-document
// ---------------------------------------------------------------------
routerAdd(
  "GET",
  "/api/vault/customers/{id}/id-document",
  (e) => {
    const customerId = e.request.pathValue("id");
    try {
      e.app.findRecordById("customers", customerId);
    } catch (err) {
      throw e.notFoundError("Customer not found. Search again or add them.", null);
    }

    // The newest row whose file is still on disk. A row whose photo the
    // retention cron has purged does not count as ID on file.
    let doc = null;
    try {
      const found = e.app.findRecordsByFilter(
        "id_documents",
        "customer = {:customer} && photo != ''",
        "-created",
        1,
        0,
        { customer: customerId }
      );
      doc = found && found.length ? found[0] : null;
    } catch (err) {
      doc = null;
    }

    return e.json(200, {
      document: doc
        ? {
            id: doc.id,
            taken_at: doc.getString("taken_at"),
            expires_at: doc.getString("expires_at"),
            taken_by: doc.getString("taken_by"),
          }
        : null,
    });
  },
  $apis.requireAuth("staff")
);

// ---------------------------------------------------------------------
// POST /api/vault/customers/{id}/merge  (step-up)
// ---------------------------------------------------------------------
routerAdd(
  "POST",
  "/api/vault/customers/{id}/merge",
  (e) => {
    const util = require(`${__hooks}/lib/vaultutil.js`);
    const stepup = require(`${__hooks}/lib/stepup.js`);
    const auditLib = require(`${__hooks}/lib/audit.js`);
    const balances = require(`${__hooks}/lib/balances.js`);

    stepup.requireStepUp(e);

    // Every relation that points at a customer. referrals appears twice,
    // once per end of the referral.
    const RELATIONS = [
      { collection: "trade_ins", field: "customer" },
      { collection: "sales", field: "customer" },
      { collection: "credit_ledger", field: "customer" },
      { collection: "points_ledger", field: "customer" },
      { collection: "quotes", field: "customer" },
      { collection: "want_list", field: "customer" },
      { collection: "notifications", field: "customer" },
      { collection: "push_subscriptions", field: "customer" },
      { collection: "reward_redemptions", field: "customer" },
      { collection: "referrals", field: "referrer" },
      { collection: "referrals", field: "referee" },
      { collection: "memberships", field: "customer" },
      { collection: "id_documents", field: "customer" },
      { collection: "items", field: "reserved_for" },
      { collection: "customers", field: "referred_by" },
    ];

    const staff = e.auth;
    const body = util.body(e);
    const duplicateId = e.request.pathValue("id");
    const targetId = util.asStr(body.into);

    if (!targetId) {
      throw e.badRequestError("Pick the customer record to keep.", null);
    }
    if (targetId === duplicateId) {
      throw e.error(409, "Those are the same record. Pick the other customer to fold in.", null);
    }
    try {
      e.app.findRecordById("customers", duplicateId);
    } catch (err) {
      throw e.notFoundError("The duplicate customer was not found. Search again.", null);
    }
    try {
      e.app.findRecordById("customers", targetId);
    } catch (err) {
      throw e.notFoundError("The customer to keep was not found. Search again.", null);
    }

    let halt = null;
    let result = null;

    try {
      e.app.runInTransaction((txApp) => {
        const duplicate = txApp.findRecordById("customers", duplicateId);
        const target = txApp.findRecordById("customers", targetId);

        const moved = {};
        function count(name, n) {
          if (!n) return;
          moved[name] = (moved[name] || 0) + n;
        }

        for (let i = 0; i < RELATIONS.length; i++) {
          const rel = RELATIONS[i];
          let rows = [];
          try {
            rows = txApp.findRecordsByFilter(
              rel.collection,
              rel.field + " = {:id}",
              "created",
              0,
              0,
              { id: duplicateId }
            );
          } catch (err) {
            rows = [];
          }
          let n = 0;
          for (let r = 0; r < rows.length; r++) {
            if (!rows[r]) continue;
            // A duplicate that referred itself would otherwise be pointed at
            // the record that is about to absorb it and left dangling.
            if (rel.collection === "customers" && rows[r].id === duplicateId) continue;
            rows[r].set(rel.field, targetId);
            txApp.save(rows[r]);
            n += 1;
          }
          count(rel.collection, n);
        }

        // perk_usage cannot simply be re-pointed: it carries a unique index
        // on (customer, perk_type, period), so a duplicate who used the same
        // perk in the same month as the record being kept would collide. The
        // two counts are added together instead, and the duplicate's row
        // goes. Where the record being kept has no row for that perk and
        // month, the duplicate's row is re-pointed, which is the same thing
        // as creating one and keeps its own history.
        let perkRows = [];
        try {
          perkRows = txApp.findRecordsByFilter("perk_usage", "customer = {:id}", "created", 0, 0, {
            id: duplicateId,
          });
        } catch (err) {
          perkRows = [];
        }
        let perkMoved = 0;
        for (let i = 0; i < perkRows.length; i++) {
          const row = perkRows[i];
          if (!row) continue;
          let existing = null;
          try {
            existing = txApp.findFirstRecordByFilter(
              "perk_usage",
              "customer = {:customer} && perk_type = {:perk} && period = {:period}",
              {
                customer: targetId,
                perk: row.getString("perk_type"),
                period: row.getString("period"),
              }
            );
          } catch (err) {
            existing = null;
          }
          if (existing) {
            existing.set("used_count", existing.getInt("used_count") + row.getInt("used_count"));
            txApp.save(existing);
            txApp.delete(row);
          } else {
            row.set("customer", targetId);
            txApp.save(row);
          }
          perkMoved += 1;
        }
        count("perk_usage", perkMoved);

        // Staff notes written against the duplicate follow it across.
        let noteRows = [];
        try {
          noteRows = txApp.findRecordsByFilter(
            "notes",
            'target_collection = "customers" && target_record = {:id}',
            "created",
            0,
            0,
            { id: duplicateId }
          );
        } catch (err) {
          noteRows = [];
        }
        for (let i = 0; i < noteRows.length; i++) {
          if (!noteRows[i]) continue;
          noteRows[i].set("target_record", targetId);
          txApp.save(noteRows[i]);
        }
        count("notes", noteRows.length);

        // --- customer_private: fill the gaps on the record being kept ----
        function privateFor(customerId) {
          try {
            return txApp.findFirstRecordByFilter("customer_private", "customer = {:customer}", {
              customer: customerId,
            });
          } catch (err) {
            return null;
          }
        }
        function flagsOf(record) {
          if (!record) return [];
          let raw = null;
          try {
            raw = record.get("flags");
          } catch (err) {
            return [];
          }
          if (!raw) return [];
          if (typeof raw === "string") return [raw];
          const out = [];
          for (let i = 0; i < raw.length; i++) out.push(String(raw[i]));
          return out;
        }

        const duplicatePrivate = privateFor(duplicateId);
        const targetPrivate = privateFor(targetId);

        if (duplicatePrivate && targetPrivate) {
          if (!targetPrivate.getString("address") && duplicatePrivate.getString("address")) {
            targetPrivate.set("address", duplicatePrivate.getString("address"));
          }
          if (!targetPrivate.getString("dob") && duplicatePrivate.getString("dob")) {
            targetPrivate.set("dob", duplicatePrivate.getString("dob"));
          }

          const union = flagsOf(targetPrivate);
          const extra = flagsOf(duplicatePrivate);
          for (let i = 0; i < extra.length; i++) {
            if (union.indexOf(extra[i]) < 0) union.push(extra[i]);
          }
          targetPrivate.set("flags", union);

          const duplicateNotes = duplicatePrivate.getString("notes");
          if (duplicateNotes) {
            const existing = targetPrivate.getString("notes");
            targetPrivate.set("notes", existing ? existing + "\n" + duplicateNotes : duplicateNotes);
          }

          // The ID only moves when the record being kept has none: a
          // verified ID on the target is the one the shop checked.
          const targetVerified = targetPrivate.getString("id_status") === "verified";
          const duplicateVerified = duplicatePrivate.getString("id_status") === "verified";
          if (!targetVerified && duplicateVerified) {
            targetPrivate.set("id_status", "verified");
            targetPrivate.set("id_type", duplicatePrivate.getString("id_type"));
            targetPrivate.set("id_expiry", duplicatePrivate.getString("id_expiry"));
            targetPrivate.set("id_ref_last4", duplicatePrivate.getString("id_ref_last4"));
            targetPrivate.set("id_verified_by", duplicatePrivate.getString("id_verified_by"));
            targetPrivate.set("id_verified_at", duplicatePrivate.getString("id_verified_at"));
          }

          txApp.save(targetPrivate);
        }

        if (duplicatePrivate) {
          txApp.delete(duplicatePrivate);
          count("customer_private", 1);
        }
        txApp.delete(duplicate);

        // Both ledgers moved wholesale, so the cached balances are
        // recomputed from the ledger rather than added up by hand.
        balances.recompute(txApp, targetId);

        auditLib.writeAuditLog(txApp, {
          actor: staff.id,
          action: "customer_merge",
          collection: "customers",
          record: targetId,
          // Ids and counts only, never a name, address or ID field.
          meta: { duplicate: duplicateId, moved: moved },
          ip: e.realIP(),
        });

        result = {
          customer: txApp.findRecordById("customers", targetId),
          moved: moved,
        };
      });
    } catch (err) {
      if (halt) throw e.error(halt.status, halt.message, null);
      throw err;
    }

    return e.json(200, result);
  },
  $apis.requireAuth("staff")
);

// ---------------------------------------------------------------------
// POST /api/vault/customers/{id}/erase  (admin, step-up)
// ---------------------------------------------------------------------
routerAdd(
  "POST",
  "/api/vault/customers/{id}/erase",
  (e) => {
    const util = require(`${__hooks}/lib/vaultutil.js`);
    const stepup = require(`${__hooks}/lib/stepup.js`);
    const auditLib = require(`${__hooks}/lib/audit.js`);
    const balances = require(`${__hooks}/lib/balances.js`);
    const money = require(`${__hooks}/lib/shared/money.js`);

    const staff = util.requireAdmin(e);
    stepup.requireStepUp(e);

    // Rows that are wholly the person's own and go with them. Their
    // trade-ins, sales and ledgers stay: UK GDPR Article 17(3)(b) keeps the
    // record the shop is required to hold, with the seller snapshot on it.
    const DELETED = ["want_list", "notifications", "push_subscriptions", "quotes"];

    const customerId = e.request.pathValue("id");
    try {
      e.app.findRecordById("customers", customerId);
    } catch (err) {
      throw e.notFoundError("Customer not found. Search again.", null);
    }

    const credit = balances.creditBalance(e.app, customerId);
    if (credit > 0) {
      throw e.error(
        422,
        `This customer still has ${money.formatGBP(credit)} store credit. Pay it out or write it off first.`,
        null
      );
    }

    let halt = null;
    let result = null;

    try {
      e.app.runInTransaction((txApp) => {
        const liveCredit = balances.creditBalance(txApp, customerId);
        if (liveCredit > 0) {
          halt = {
            status: 422,
            message: `This customer still has ${money.formatGBP(liveCredit)} store credit. Pay it out or write it off first.`,
          };
          throw new Error(halt.message);
        }

        const removed = {};

        // --- the ID photos, file and all -------------------------------
        let documents = [];
        try {
          documents = txApp.findRecordsByFilter("id_documents", "customer = {:customer}", "created", 0, 0, {
            customer: customerId,
          });
        } catch (err) {
          documents = [];
        }
        for (let i = 0; i < documents.length; i++) {
          if (documents[i]) txApp.delete(documents[i]);
        }
        removed.id_documents = documents.length;

        // --- vouchers they will never come back for ---------------------
        let issued = [];
        try {
          issued = txApp.findRecordsByFilter(
            "reward_redemptions",
            'customer = {:customer} && status = "issued"',
            "created",
            0,
            0,
            { customer: customerId }
          );
        } catch (err) {
          issued = [];
        }
        for (let i = 0; i < issued.length; i++) {
          if (!issued[i]) continue;
          issued[i].set("status", "cancelled");
          txApp.save(issued[i]);
        }
        removed.reward_redemptions = issued.length;

        // --- their own rows ---------------------------------------------
        for (let i = 0; i < DELETED.length; i++) {
          let rows = [];
          try {
            rows = txApp.findRecordsByFilter(DELETED[i], "customer = {:customer}", "created", 0, 0, {
              customer: customerId,
            });
          } catch (err) {
            rows = [];
          }
          for (let r = 0; r < rows.length; r++) {
            if (rows[r]) txApp.delete(rows[r]);
          }
          removed[DELETED[i]] = rows.length;
        }

        // --- customer_private -------------------------------------------
        let priv = null;
        try {
          priv = txApp.findFirstRecordByFilter("customer_private", "customer = {:customer}", {
            customer: customerId,
          });
        } catch (err) {
          priv = null;
        }
        if (priv) {
          priv.set("address", "");
          priv.set("dob", "");
          priv.set("notes", "");
          priv.set("flags", []);
          priv.set("id_status", "none");
          priv.set("id_type", "");
          priv.set("id_expiry", "");
          priv.set("id_ref_last4", "");
          priv.set("id_verified_by", "");
          priv.set("id_verified_at", "");
          txApp.save(priv);
        }

        // --- the customer record itself ----------------------------------
        // The code stays: it is on printed receipts and on the six-year
        // buy-in register, and it identifies nobody on its own.
        const customer = txApp.findRecordById("customers", customerId);
        customer.set("name", "Erased customer");
        customer.set("email", "");
        customer.set("phone", "");
        customer.set("marketing_consent", false);
        customer.set("birthday_month", null);
        // Rotated, so a QR card already in a wallet stops resolving.
        customer.set("qr_token", $security.randomString(32));
        txApp.save(customer);

        auditLib.writeAuditLog(txApp, {
          actor: staff.id,
          action: "customer_erase",
          collection: "customers",
          record: customerId,
          // Ids and counts only.
          meta: { removed: removed },
          ip: e.realIP(),
        });

        result = { erased: true, customer: txApp.findRecordById("customers", customerId) };
      });
    } catch (err) {
      if (halt) throw e.error(halt.status, halt.message, null);
      throw err;
    }

    return e.json(200, result);
  },
  $apis.requireAuth("staff")
);
