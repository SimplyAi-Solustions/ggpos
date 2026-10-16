/// <reference path="../pb_data/types.d.ts" />

/**
 * suppliers.pb.js - the record hooks behind the supplier reorder report
 * (docs/api-contract-reorder.md, section 2). The collection API's own rules
 * (pb_migrations/1789821300_supplier_reorder.js) still decide who may write
 * what; these hooks say what a write must look like, before PocketBase's own
 * validation, and refuse with a plain sentence when it does not.
 *
 * - `suppliers`: the name is trimmed, required and unique whatever the case;
 *   a supplier any stock row or request points at cannot be deleted.
 * - `items`: Keep on shelf (`shelf_target`) is a whole number, 0 or more, and
 *   the supplier's code is trimmed. `supplier` and the other two fields need
 *   nothing more: the item's rules and hooks already let them through.
 * - `stock_requests`: a customer request is shaped and checked on create and
 *   on update, and a new one is stamped with who logged it and when.
 *
 * The report itself is reorder.pb.js's. Logic is in lib/suppliers.js.
 *
 * Each registered handler runs in its own isolated goja context, so every
 * require() lives inside the handler body - see pb/README.md.
 */

// ---------------------------------------------------------------------
// suppliers
// ---------------------------------------------------------------------
onRecordCreateRequest((e) => {
  const suppliers = require(`${__hooks}/lib/suppliers.js`);
  const refusal = suppliers.supplierProblem(e.app, e.record, true);
  if (refusal) throw e.error(refusal.status, refusal.message, null);
  e.next();
}, "suppliers");

onRecordUpdateRequest((e) => {
  const suppliers = require(`${__hooks}/lib/suppliers.js`);
  const refusal = suppliers.supplierProblem(e.app, e.record, false);
  if (refusal) throw e.error(refusal.status, refusal.message, null);
  e.next();
}, "suppliers");

onRecordDeleteRequest((e) => {
  const suppliers = require(`${__hooks}/lib/suppliers.js`);
  const refusal = suppliers.supplierDeleteProblem(e.app, e.record);
  if (refusal) throw e.error(refusal.status, refusal.message, null);
  e.next();
}, "suppliers");

// ---------------------------------------------------------------------
// items: Keep on shelf and the supplier's code
// ---------------------------------------------------------------------
onRecordCreateRequest((e) => {
  const suppliers = require(`${__hooks}/lib/suppliers.js`);
  const refusal = suppliers.itemProblem(e.record);
  if (refusal) throw e.error(refusal.status, refusal.message, null);
  e.next();
}, "items");

onRecordUpdateRequest((e) => {
  const suppliers = require(`${__hooks}/lib/suppliers.js`);
  const refusal = suppliers.itemProblem(e.record);
  if (refusal) throw e.error(refusal.status, refusal.message, null);
  e.next();
}, "items");

// ---------------------------------------------------------------------
// stock_requests
// ---------------------------------------------------------------------
onRecordCreateRequest((e) => {
  const suppliers = require(`${__hooks}/lib/suppliers.js`);
  const refusal = suppliers.requestProblem(e, true);
  if (refusal) throw e.error(refusal.status, refusal.message, null);
  e.next();
}, "stock_requests");

onRecordUpdateRequest((e) => {
  const suppliers = require(`${__hooks}/lib/suppliers.js`);
  const refusal = suppliers.requestProblem(e, false);
  if (refusal) throw e.error(refusal.status, refusal.message, null);
  e.next();
}, "stock_requests");
