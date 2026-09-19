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
 * The two collection-name lists are read at file-load time (registration
 * is synchronous, in the same context as this top level), but each
 * handler body still defines its own actor helper rather than sharing
 * one - see items.pb.js's top comment for why.
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
  e.next();

  const audit = require(`${__hooks}/lib/audit.js`);
  audit.writeAuditLog(e.app, {
    actor: e.auth ? e.auth.id : "system",
    action: "delete",
    collection: e.record.collection().name,
    record: e.record.id,
    meta: { fields: e.record.fieldsData() },
    ip: e.realIP(),
  });
}, ...AUDITED_DELETE_COLLECTIONS);

onRecordUpdateRequest((e) => {
  e.next();

  const audit = require(`${__hooks}/lib/audit.js`);
  audit.writeAuditLog(e.app, {
    actor: e.auth ? e.auth.id : "system",
    action: "update",
    collection: e.record.collection().name,
    record: e.record.id,
    meta: { fields: e.record.fieldsData() },
    ip: e.realIP(),
  });
}, ...AUDITED_UPDATE_COLLECTIONS);
