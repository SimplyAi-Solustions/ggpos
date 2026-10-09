/// <reference path="../pb_data/types.d.ts" />

/**
 * categories.pb.js - the stock category tree
 * (docs/api-contract-inventory.md, section 1).
 *
 *   GET  /api/vault/categories/tree             (staff)
 *   POST /api/vault/categories/{id}/move        (capability stock_manage)
 *   POST /api/vault/categories/reorder          (capability stock_manage)
 *   POST /api/vault/categories/assign           (capability stock_manage)
 *
 * Plus the record hooks that keep the tree sound whoever writes it, through
 * the collection API or a route above:
 *
 * - `categories`: the name, parent, depth and sibling-name refusals (400),
 *   Unsorted kept (409), a delete refused while the branch holds anything
 *   (409), `key` never set by a request, and `path`, `lineage` and `depth`
 *   always worked out from the parent, with every branch beneath a renamed or
 *   moved one rewritten in the same transaction. Section 1.2.
 * - `items` and `till_products`: a `category` that does not exist is refused
 *   (400), and a till product with none goes to Unsorted. An item with none is
 *   filed in items.pb.js, beside the SKU and title it also assigns.
 *
 * The collection API's own rules still decide who may write a branch
 * (manager and admin); the routes use the capability and the override flow of
 * lib/permissions.js. Logic is in lib/categories.js.
 *
 * Each registered handler runs in its own isolated goja context, so every
 * require() and helper lives inside the handler body - see pb/README.md.
 */

// ---------------------------------------------------------------------
// categories: the refusals, before PocketBase's own validation
// ---------------------------------------------------------------------
onRecordCreateRequest((e) => {
  const categories = require(`${__hooks}/lib/categories.js`);
  categories.shapeCreate(e);
  const refusal = categories.checkWrite(e.app, e.record, true);
  if (refusal) throw e.error(refusal.status, refusal.message, null);
  e.next();
}, "categories");

onRecordUpdateRequest((e) => {
  const categories = require(`${__hooks}/lib/categories.js`);
  categories.keepKey(e.record);
  const refusal = categories.checkWrite(e.app, e.record, false);
  if (refusal) throw e.error(refusal.status, refusal.message, null);
  // A rename or a move that has branches beneath it writes them all, or none.
  if (categories.rewritesSubtree(e.app, e.record)) {
    categories.nextInTransaction(e);
  } else {
    e.next();
  }
}, "categories");

onRecordDeleteRequest((e) => {
  const categories = require(`${__hooks}/lib/categories.js`);
  const refusal = categories.deleteProblem(e.app, e.record);
  if (refusal) throw e.error(refusal.status, refusal.message, null);
  e.next();
}, "categories");

// ---------------------------------------------------------------------
// categories: the derived fields, whoever saves the record. Runs inside the
// caller's transaction when it has one (the routes below, the request
// wrapper above).
// ---------------------------------------------------------------------
onRecordCreate((e) => {
  const categories = require(`${__hooks}/lib/categories.js`);
  categories.deriveFields(e.app, e.record);
  e.next();
}, "categories");

onRecordUpdate((e) => {
  const categories = require(`${__hooks}/lib/categories.js`);
  const changed = categories.deriveFields(e.app, e.record);
  e.next();
  if (changed) categories.rewriteChildren(e.app, e.record);
}, "categories");

// ---------------------------------------------------------------------
// items and till_products: the branch has to exist
// ---------------------------------------------------------------------
onRecordCreateRequest((e) => {
  const categories = require(`${__hooks}/lib/categories.js`);
  const refusal = categories.homeProblem(e.app, e.record, true);
  if (refusal) throw e.error(refusal.status, refusal.message, null);
  e.next();
}, "items", "till_products");

onRecordUpdateRequest((e) => {
  const categories = require(`${__hooks}/lib/categories.js`);
  const refusal = categories.homeProblem(e.app, e.record, false);
  if (refusal) throw e.error(refusal.status, refusal.message, null);
  e.next();
}, "items", "till_products");

// A till product created with no branch goes to Unsorted for staff to file.
onRecordCreate((e) => {
  if (!e.record.getString("category")) {
    const categories = require(`${__hooks}/lib/categories.js`);
    const unsorted = categories.unsortedId(e.app);
    if (unsorted) e.record.set("category", unsorted);
  }
  e.next();
}, "till_products");

// ---------------------------------------------------------------------
// GET /api/vault/categories/tree   (staff)
// ---------------------------------------------------------------------
routerAdd(
  "GET",
  "/api/vault/categories/tree",
  (e) => {
    const categories = require(`${__hooks}/lib/categories.js`);
    return e.json(200, categories.treeResponse(e.app));
  },
  $apis.requireAuth("staff")
);

// ---------------------------------------------------------------------
// POST /api/vault/categories/{id}/move   (stock_manage)
//
// { parent: "<id>" | "", before?: "<sibling id>" }. The branch goes under
// `parent`, before `before` or last; the new parent's children are numbered
// 10, 20, 30 and the branch's subtree follows (the update hook). Answers the
// whole tree.
// ---------------------------------------------------------------------
routerAdd(
  "POST",
  "/api/vault/categories/{id}/move",
  (e) => {
    const util = require(`${__hooks}/lib/vaultutil.js`);
    const auditLib = require(`${__hooks}/lib/audit.js`);
    const perms = require(`${__hooks}/lib/permissions.js`);
    const tillLib = require(`${__hooks}/lib/till.js`);
    const categories = require(`${__hooks}/lib/categories.js`);

    const plan = categories.planMove(e.app, e.request.pathValue("id"), util.body(e));
    if (!plan.ok) throw e.error(plan.status, plan.message, null);

    // Capability last, so a manager is only asked to approve a move that
    // will otherwise go through.
    const grant = perms.check(e, "stock_manage");
    if (!grant.ok) return perms.refuse(e, grant);

    let halt = null;
    try {
      e.app.runInTransaction((txApp) => {
        halt = tillLib.consume(txApp, grant, "category_move:" + plan.id);
        if (halt) throw new Error(halt.message);
        categories.runMove(txApp, plan);
        auditLib.writeAuditLog(txApp, {
          actor: e.auth.id,
          action: "category_move",
          collection: "categories",
          record: plan.id,
          meta: { parent: plan.parent, before: plan.before, approvals: perms.auditMeta(grant) },
          ip: e.realIP(),
        });
      });
    } catch (err) {
      if (halt) throw e.error(halt.status, halt.message, null);
      throw err;
    }

    return e.json(200, categories.treeResponse(e.app));
  },
  $apis.requireAuth("staff")
);

// ---------------------------------------------------------------------
// POST /api/vault/categories/reorder   (stock_manage)
//
// { parent: "<id>" | "", order: ["<id>", ...] }: every child of `parent`
// exactly once, numbered 10, 20, 30 in that order. Answers the whole tree.
// ---------------------------------------------------------------------
routerAdd(
  "POST",
  "/api/vault/categories/reorder",
  (e) => {
    const util = require(`${__hooks}/lib/vaultutil.js`);
    const auditLib = require(`${__hooks}/lib/audit.js`);
    const perms = require(`${__hooks}/lib/permissions.js`);
    const tillLib = require(`${__hooks}/lib/till.js`);
    const categories = require(`${__hooks}/lib/categories.js`);

    const plan = categories.planReorder(e.app, util.body(e));
    if (!plan.ok) throw e.error(plan.status, plan.message, null);

    const grant = perms.check(e, "stock_manage");
    if (!grant.ok) return perms.refuse(e, grant);

    let halt = null;
    try {
      e.app.runInTransaction((txApp) => {
        halt = tillLib.consume(txApp, grant, "category_reorder:" + (plan.parent || "top"));
        if (halt) throw new Error(halt.message);
        categories.runReorder(txApp, plan);
        auditLib.writeAuditLog(txApp, {
          actor: e.auth.id,
          action: "category_reorder",
          collection: "categories",
          record: plan.parent,
          meta: { parent: plan.parent, branches: plan.writes.length, approvals: perms.auditMeta(grant) },
          ip: e.realIP(),
        });
      });
    } catch (err) {
      if (halt) throw e.error(halt.status, halt.message, null);
      throw err;
    }

    return e.json(200, categories.treeResponse(e.app));
  },
  $apis.requireAuth("staff")
);

// ---------------------------------------------------------------------
// POST /api/vault/categories/assign   (stock_manage)
//
// { category, items?, products? }: files those stock rows and till products
// into the branch, up to 500 between them, in one transaction with one
// `category_assign` audit row. Answers { items, products }. This is how
// Unsorted is emptied.
// ---------------------------------------------------------------------
routerAdd(
  "POST",
  "/api/vault/categories/assign",
  (e) => {
    const util = require(`${__hooks}/lib/vaultutil.js`);
    const auditLib = require(`${__hooks}/lib/audit.js`);
    const perms = require(`${__hooks}/lib/permissions.js`);
    const tillLib = require(`${__hooks}/lib/till.js`);
    const categories = require(`${__hooks}/lib/categories.js`);

    const plan = categories.planAssign(e.app, util.body(e));
    if (!plan.ok) throw e.error(plan.status, plan.message, null);

    const grant = perms.check(e, "stock_manage");
    if (!grant.ok) return perms.refuse(e, grant);

    let halt = null;
    let result = null;
    try {
      e.app.runInTransaction((txApp) => {
        halt = tillLib.consume(txApp, grant, "category_assign:" + plan.category);
        if (halt) throw new Error(halt.message);
        result = categories.runAssign(txApp, plan);
        auditLib.writeAuditLog(txApp, {
          actor: e.auth.id,
          action: "category_assign",
          collection: "categories",
          record: plan.category,
          meta: {
            category: plan.category,
            items: result.items,
            products: result.products,
            approvals: perms.auditMeta(grant),
          },
          ip: e.realIP(),
        });
      });
    } catch (err) {
      if (halt) throw e.error(halt.status, halt.message, null);
      throw err;
    }

    return e.json(200, result);
  },
  $apis.requireAuth("staff")
);
