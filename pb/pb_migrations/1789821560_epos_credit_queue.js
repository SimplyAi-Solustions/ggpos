/// <reference path="../pb_data/types.d.ts" />

/**
 * Store credit from a Vault deal, queued for Epos Now.
 *
 * The shop still runs Epos Now at the till for spending store credit, so
 * when POST /api/vault/deals/{id}/complete gives credit, one row goes into
 * `epos_credit_queue` in the same transaction. A worker on the shop Mac
 * (deploy/mac/epos-credit-sync.mjs), which holds the Epos Now token, picks
 * pending rows up, finds or creates the customer in Epos Now and adds the
 * credit to their Epos balance. The token never reaches this server.
 *
 * Additive only.
 *
 * `epos_credit_queue` (superuser only: every rule null; staff read the
 * status through GET /api/vault/deals/{id}/epos-credit):
 *  - trade_in            the completed deal. Unique, so a deal can only
 *                        ever queue its credit once.
 *  - customer            the Vault customer the credit belongs to.
 *  - amount              int pence, above 0: the credit given.
 *  - status              pending | sending | done | failed | needs_check.
 *                        `sending` is set before the balance call; a row
 *                        left in it means the outcome is unknown, and the
 *                        worker moves it to needs_check, never back to
 *                        pending. needs_check is resolved by a person.
 *  - epos_customer_id    the Epos Now customer id credited. 0 = not yet known.
 *  - epos_balance_after  int pence, the Epos balance the API reported after
 *                        the credit. Only meaningful when status is done
 *                        and sent_at is set.
 *  - attempts            tries made so far (the worker stops at 5).
 *  - last_error          the last failure, for the operator.
 *  - sent_at             when Epos Now confirmed the credit.
 *
 * `customers.epos_customer_id`: the matching Epos Now customer, saved by
 * the worker once found or created, so later credits skip the lookup. 0 =
 * not linked. A customer cannot change it on their own record (the
 * updateRule refuses it), because it decides whose Epos balance is credited.
 */
migrate(
  (app) => {
    const customers = app.findCollectionByNameOrId("customers");
    const tradeIns = app.findCollectionByNameOrId("trade_ins");

    if (!customers.fields.getByName("epos_customer_id")) {
      customers.fields.add(
        new Field({ name: "epos_customer_id", type: "number", onlyInt: true, min: 0 })
      );
    }
    const selfEdit = "@request.body.source:isset = false";
    if (customers.updateRule && customers.updateRule.indexOf(selfEdit) !== -1 &&
        customers.updateRule.indexOf("epos_customer_id") === -1) {
      customers.updateRule = customers.updateRule.replace(
        selfEdit,
        selfEdit + " && @request.body.epos_customer_id:isset = false"
      );
    }
    app.save(customers);

    const queue = new Collection({
      name: "epos_credit_queue",
      type: "base",
      listRule: null,
      viewRule: null,
      createRule: null,
      updateRule: null,
      deleteRule: null,
      fields: [
        { name: "trade_in", type: "relation", required: true, collectionId: tradeIns.id, maxSelect: 1 },
        { name: "customer", type: "relation", required: true, collectionId: customers.id, maxSelect: 1 },
        { name: "amount", type: "number", required: true, onlyInt: true, min: 1 },
        {
          name: "status",
          type: "select",
          required: true,
          maxSelect: 1,
          values: ["pending", "sending", "done", "failed", "needs_check"],
        },
        { name: "epos_customer_id", type: "number", onlyInt: true, min: 0 },
        { name: "epos_balance_after", type: "number", onlyInt: true },
        { name: "attempts", type: "number", onlyInt: true, min: 0 },
        { name: "last_error", type: "text", max: 2000 },
        { name: "sent_at", type: "date" },
        { name: "created", type: "autodate", onCreate: true },
        { name: "updated", type: "autodate", onCreate: true, onUpdate: true },
      ],
    });
    queue.addIndex("idx_epos_credit_queue_trade_in_unique", true, "trade_in", "");
    queue.addIndex("idx_epos_credit_queue_status", false, "status, created", "");
    app.save(queue);
  },
  (app) => {
    try {
      app.delete(app.findCollectionByNameOrId("epos_credit_queue"));
    } catch (err) {
      // already gone
    }
    const customers = app.findCollectionByNameOrId("customers");
    if (customers.updateRule) {
      customers.updateRule = customers.updateRule.replace(
        " && @request.body.epos_customer_id:isset = false",
        ""
      );
    }
    customers.fields.removeByName("epos_customer_id");
    app.save(customers);
  }
);
