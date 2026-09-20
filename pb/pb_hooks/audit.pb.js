/// <reference path="../pb_data/types.d.ts" />

/**
 * audit.pb.js
 *
 * Writes an audit_log row for:
 *  - deletes on the collections holding the shop's most sensitive data
 *    (PII, money and stock);
 *  - updates to pricing_rules, every loyalty_* collection and settings,
 *    per PLAN.md's "Written for ... price overrides ... loyalty rule
 *    changes" and "admin role for settings, pricing_rules, loyalty_*".
 *
 * Both use the *Request hook variants (not the plain onRecordUpdate /
 * onRecordDelete) because only the request-level event carries who made
 * the call (e.auth) and from where (e.realIP()). e.next() is called
 * exactly once and the audit row is only written once it returns without
 * throwing, so a rejected update or delete is never logged as if it had
 * happened.
 *
 * `meta` never carries field VALUES from customers, customer_private,
 * id_documents, staff or settings - only identifiers, changed field
 * NAMES (for updates) and a small set of known-safe labels (for deletes):
 * audit_log is a permanent, superuser-only table, so copying a password
 * hash, pin_hash, ID photo path or an API key into it would defeat GDPR
 * erasure on the original record and leak secrets nowhere else are kept.
 * See pb/README.md.
 *
 * The two collection-name lists are read at file-load time (registration
 * is synchronous, in the same context as this top level), but each
 * handler body still defines its own helpers rather than sharing them -
 * see items.pb.js's top comment for why.
 */

// Collections whose *deletion* is always worth a permanent record: PII,
// money movements and stock. This list is a judgement call (PLAN.md says
// "sensitive collections" without enumerating them) - see pb/README.md.
const AUDITED_DELETE_COLLECTIONS = [
  "staff",
  "customers",
  "customer_private",
  "id_documents",
  "items",
  "trade_ins",
  "sales",
  "credit_ledger",
  "points_ledger",
];

const AUDITED_UPDATE_COLLECTIONS = [
  "pricing_rules",
  "loyalty_programme",
  "loyalty_rules",
  "loyalty_tiers",
  "loyalty_rewards",
  "settings",
];

onRecordDeleteRequest((e) => {
  // Collections in AUDITED_DELETE_COLLECTIONS whose one identifying field
  // is known to carry no PII or secret, keyed to that field's name. Every
  // other audited collection - staff, customers, customer_private and
  // id_documents above all - gets no label at all: never even the field
  // NAME is reason enough to read one of their fields into this table,
  // only id + collection. Defined inside the handler, not at file top
  // level - see this file's top comment and items.pb.js's for why.
  const SAFE_DELETE_LABEL_FIELDS = {
    items: "sku",
    trade_ins: "number",
    sales: "number",
  };

  const collectionName = e.record.collection().name;
  const recordId = e.record.id;
  const labelField = SAFE_DELETE_LABEL_FIELDS[collectionName];
  const label = labelField ? e.record.getString(labelField) : "";

  e.next();

  const audit = require(`${__hooks}/lib/audit.js`);
  audit.writeAuditLog(e.app, {
    actor: e.auth ? e.auth.id : "system",
    action: "delete",
    collection: collectionName,
    record: recordId,
    meta: label ? { label: label } : {},
    ip: e.realIP(),
  });
}, ...AUDITED_DELETE_COLLECTIONS);

onRecordUpdateRequest((e) => {
  /**
   * Field NAMES that differ between the record's original (pre-request)
   * state and its current (request-bound) state - never their values.
   * Computed before e.next() so "original" reliably means "as it was
   * before this request", not whatever original() reports once the save
   * this e.next() triggers has gone through.
   */
  function changedFieldNames(record) {
    let original = null;
    try {
      original = record.original();
    } catch (err) {
      original = null;
    }
    const data = record.fieldsData();
    const names = [];
    for (const key in data) {
      if (key === "created" || key === "updated") continue;
      if (!original || JSON.stringify(original.get(key)) !== JSON.stringify(data[key])) {
        names.push(key);
      }
    }
    return names;
  }

  const collectionName = e.record.collection().name;
  const recordId = e.record.id;
  const fields = changedFieldNames(e.record);

  e.next();

  const audit = require(`${__hooks}/lib/audit.js`);
  audit.writeAuditLog(e.app, {
    actor: e.auth ? e.auth.id : "system",
    action: "update",
    collection: collectionName,
    record: recordId,
    meta: { fields: fields },
    ip: e.realIP(),
  });
}, ...AUDITED_UPDATE_COLLECTIONS);
