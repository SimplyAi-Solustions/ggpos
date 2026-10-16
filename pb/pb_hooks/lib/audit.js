/**
 * Write one row to audit_log. Called from hook handlers with the live
 * $app (or a transaction's txApp), so this always runs with superuser
 * privileges and bypasses audit_log's own (all-null, superuser-only)
 * API rules - exactly as intended.
 *
 * require() this from inside each handler, not at file top level - see
 * pb/README.md on pb_hooks isolation.
 */

/**
 * @param {any} app - $app or a txApp from $app.runInTransaction.
 * @param {{actor?: string, action: string, collection: string, record?: string, meta?: object, ip?: string}} opts
 */
function writeAuditLog(app, opts) {
  opts = opts || {};
  var collection = app.findCollectionByNameOrId("audit_log");
  var record = new Record(collection, {
    actor: opts.actor || "system",
    action: opts.action || "",
    collection: opts.collection || "",
    record: opts.record || "",
    meta: opts.meta || {},
    ip: opts.ip || "",
  });
  app.save(record);
  return record;
}

module.exports = { writeAuditLog: writeAuditLog };
