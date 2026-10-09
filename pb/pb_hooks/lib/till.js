/**
 * Till sessions and their X and Z reports (docs/api-contract-epos.md,
 * section 3), the PocketBase side of packages/shared/src/till.ts.
 *
 * What is here is glue: read a session's records, hand them to the shared
 * `buildTillReport` (lib/shared/till.js) in the shape it takes, shape a
 * `TillSession`, save a numbered report, and say what the routes in
 * till.pb.js answer with. Every figure on a report is worked out in the
 * shared builder, never here, so the server and the counter's preview
 * cannot disagree.
 *
 * Which records belong to a session:
 * - sales: `sales.cash_session`, with their lines in "created,id" order (the
 *   order the ticket discount's remainder is assigned in, lib/vaultutil.js);
 * - tenders: `sale_tenders.session`, sale and refund rows alike, so a refund
 *   given today of last week's sale counts today;
 * - the drawer: `cash_movements.session`;
 * - buy-ins: completed `trade_ins` whose `cash_session` is the session,
 *   whatever they paid out, part-exchanges included;
 * - voids, no sales and overrides: `till_events.session`.
 *
 * Every function takes the app it should read with, so a route inside
 * `runInTransaction` passes its txApp and sees its own writes.
 *
 * require() this from inside each handler, not at file top level - see
 * pb/README.md on pb_hooks isolation.
 */

var ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

/** The contract's refusal for every route but `open` and the reads when no session is open. */
var NOT_OPEN = "Open the till first.";

function sharedTill() {
  return require(__hooks + "/lib/shared/till.js");
}

function vaultutil() {
  return require(__hooks + "/lib/vaultutil.js");
}

/** A PocketBase date ("2026-10-09 14:00:00.000Z") as ISO 8601. Empty stays empty. */
function iso(value) {
  var s = value ? String(value) : "";
  return s ? s.replace(" ", "T") : "";
}

/** Now, ISO 8601. */
function now() {
  return new Date().toISOString();
}

/** A record id for a report, chosen before it is built so the report can carry it. */
function newId() {
  return $security.randomStringWithAlphabet(15, ID_ALPHABET);
}

/** A query string value, trimmed, or "". */
function query(e, name) {
  var csv = require(__hooks + "/lib/csv.js");
  return csv.queryParam(e, name);
}

/**
 * A request body value as plain JavaScript data. A nested object in the body
 * arrives as a Go map, which reads like an object but is not one; one JSON
 * round trip makes it ordinary data before the shared checks look at it.
 */
function plain(value) {
  if (value === undefined || value === null) return value;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch (err) {
    return undefined;
  }
}

/**
 * A body value meant to be whole pence: `{ given: false }` when it is absent,
 * blank or null, `{ given: true, ok: true, value }` for a whole number, and
 * `{ given: true, ok: false }` for anything else. A string counts only when
 * it is plain digits, so "68.00" (pounds, or a slip) is refused rather than
 * read as 68p.
 */
function pence(value) {
  if (value === undefined || value === null || value === "") return { given: false, ok: true, value: 0 };
  var n = NaN;
  if (typeof value === "number") n = value;
  else if (typeof value === "string" && /^-?\d+$/.test(value.trim())) n = Number(value.trim());
  if (!Number.isSafeInteger(n)) return { given: true, ok: false, value: 0 };
  return { given: true, ok: true, value: n };
}

/** The refusal for money out that would leave the drawer expected to hold less than nothing. */
function drawerMessage(expected) {
  var money = require(__hooks + "/lib/shared/money.js");
  return "That is more than the " + money.formatGBP(Math.max(0, expected)) + " the drawer should hold.";
}

/** A unique-index collision, whichever shape PocketBase reports it in (as cash.pb.js). */
function isUniqueViolation(err) {
  var text = String((err && err.message) || err || "");
  return /value must be unique/i.test(text) || /unique constraint/i.test(text);
}

/**
 * The register a request names (or the default one), or a thrown refusal
 * with lib/registers.js's own status and sentence.
 */
function registerFor(e, id) {
  var registers = require(__hooks + "/lib/registers.js");
  var found = registers.resolve(e.app, id);
  if (!found.register) throw e.error(found.status, found.message, null);
  return found.register;
}

/** The open session on a register, or null. */
function openSession(app, registerId) {
  var registers = require(__hooks + "/lib/registers.js");
  return registers.openSession(app, registerId);
}

/** `{ id, name }` for a register record. */
function registerRef(register) {
  return { id: register.id, name: register.getString("name") };
}

/** `{ id, name }` for a staff id, through a per-request cache. An unknown id has an empty name. */
function staffRef(app, id, cache) {
  if (!id) return { id: "", name: "" };
  if (cache && cache[id]) return cache[id];
  var name = "";
  try {
    name = app.findRecordById("staff", id).getString("name");
  } catch (err) {
    name = "";
  }
  var ref = { id: id, name: name };
  if (cache) cache[id] = ref;
  return ref;
}

/** `{ id, name }` for an optional staff id, or null when there is none. */
function optionalStaffRef(app, id, cache) {
  return id ? staffRef(app, id, cache) : null;
}

/** A json field holding a DenominationCounts, or null. */
function countsOf(record, field) {
  var value = vaultutil().jsonField(record, field, null);
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value;
}

/** `TillSession` (packages/shared/src/epos-types.ts). */
function sessionShape(app, session, register, cache) {
  return {
    id: session.id,
    register: registerRef(register),
    opened_at: iso(session.getString("opened_at")),
    opened_by: staffRef(app, session.getString("opened_by"), cache),
    float: session.getInt("float"),
    opening_counts: countsOf(session, "opening_counts"),
  };
}

/** Records by id from a list of ids, skipping blanks and missing rows. */
function byIds(app, collection, ids) {
  var out = {};
  var wanted = [];
  var seen = {};
  for (var i = 0; i < ids.length; i++) {
    if (ids[i] && !seen[ids[i]]) {
      seen[ids[i]] = true;
      wanted.push(ids[i]);
    }
  }
  if (!wanted.length) return out;
  var found = app.findRecordsByIds(collection, wanted);
  for (var j = 0; j < found.length; j++) {
    if (found[j]) out[found[j].id] = found[j];
  }
  return out;
}

/**
 * The category label for every line: a till product's category name, or the
 * stock line's kind as the shared `categoryForKind` names it. A product with
 * no category, a deleted item and a line with neither sell as "Other".
 */
function lineCategories(app, lines) {
  var till = sharedTill();
  var productIds = [];
  var itemIds = [];
  for (var i = 0; i < lines.length; i++) {
    productIds.push(lines[i].getString("product"));
    itemIds.push(lines[i].getString("item"));
  }
  var products = byIds(app, "till_products", productIds);
  var items = byIds(app, "items", itemIds);
  var categoryIds = [];
  for (var id in products) categoryIds.push(products[id].getString("category"));
  var categories = byIds(app, "till_categories", categoryIds);

  var out = {};
  for (var k = 0; k < lines.length; k++) {
    var line = lines[k];
    var product = products[line.getString("product")];
    var item = items[line.getString("item")];
    var label = "Other";
    if (product) {
      var category = categories[product.getString("category")];
      if (category && category.getString("name")) label = category.getString("name");
    } else if (item) {
      label = till.categoryForKind(item.getString("kind"));
    }
    out[line.id] = label;
  }
  return out;
}

/**
 * Every row matching a filter. A query that fails throws rather than reading
 * as no rows: a report that silently left out a day's sales would be worse
 * than one that does not run.
 */
function rows(app, collection, filter, sort, params) {
  return app.findRecordsByFilter(collection, filter, sort, 0, 0, params);
}

/**
 * The shared builder's input for a session (`TillReportInput`).
 * opts: { type, number, id, created, createdBy: { id, name }, close, cache }.
 */
function reportInput(app, session, register, opts) {
  var util = vaultutil();
  var cache = opts.cache || {};
  var params = { s: session.id };

  // Sales and their lines, the lines in the one order the ticket discount is
  // spread in (lib/vaultutil.js saleLineRows).
  var saleRows = rows(app, "sales", "cash_session = {:s}", "occurred_at,created,id", params);
  var lineRows = rows(app, "sale_lines", "sale.cash_session = {:s}", "created,id", params);
  var categories = lineCategories(app, lineRows);
  var linesBySale = {};
  for (var i = 0; i < lineRows.length; i++) {
    var line = lineRows[i];
    var saleId = line.getString("sale");
    if (!linesBySale[saleId]) linesBySale[saleId] = [];
    linesBySale[saleId].push({
      qty: Math.max(1, line.getInt("qty")),
      unit_price: line.getInt("unit_price"),
      discount: line.getInt("discount"),
      vat_rate: line.getFloat("vat_rate"),
      vat_amount: line.getInt("vat_amount"),
      tax_scheme: line.getString("tax_scheme") || "margin",
      category: categories[line.id] || "Other",
    });
  }
  var sales = [];
  for (var j = 0; j < saleRows.length; j++) {
    var sale = saleRows[j];
    sales.push({
      id: sale.id,
      occurred_at: iso(sale.getString("occurred_at") || sale.getString("created")),
      staff: staffRef(app, sale.getString("staff"), cache),
      discount: sale.getInt("discount"),
      lines: linesBySale[sale.id] || [],
    });
  }

  var tenders = [];
  var tenderRows = rows(app, "sale_tenders", "session = {:s}", "created,id", params);
  for (var t = 0; t < tenderRows.length; t++) {
    tenders.push({
      method: tenderRows[t].getString("method"),
      amount: tenderRows[t].getInt("amount"),
      refund_ref: tenderRows[t].getString("refund_ref"),
    });
  }

  // The same rows lib/vaultutil.js sessionExpected sums, read here through
  // rows() so a failed query stops the report instead of emptying the drawer.
  var movements = [];
  var movementRows = rows(app, "cash_movements", "session = {:s}", "created,id", params);
  for (var m = 0; m < movementRows.length; m++) {
    movements.push({ type: movementRows[m].getString("type"), amount: movementRows[m].getInt("amount") });
  }

  // Every completed trade-in on the session, whatever it paid out: a
  // credit-only buy-in and a part-exchange are linked to the session too
  // (lib/tradeincomplete.js). On a part-exchange `payout_cash` and
  // `payout_credit` are the surplus alone and `part_exchange_value` is what
  // it paid towards the sale (section 7).
  var tradeIns = [];
  var tradeRows = rows(app, "trade_ins", "cash_session = {:s} && status = 'completed'", "completed_at,id", params);
  for (var b = 0; b < tradeRows.length; b++) {
    tradeIns.push({
      payout_cash: tradeRows[b].getInt("payout_cash"),
      payout_credit: tradeRows[b].getInt("payout_credit"),
      part_exchange_value: tradeRows[b].getInt("part_exchange_value"),
    });
  }

  var events = [];
  var eventRows = rows(app, "till_events", "session = {:s}", "created,id", params);
  for (var v = 0; v < eventRows.length; v++) {
    events.push({ kind: eventRows[v].getString("kind"), amount: eventRows[v].getInt("amount") });
  }

  var settings = util.settings(app);

  return {
    type: opts.type,
    number: opts.number || 0,
    id: opts.id || "",
    register: registerRef(register),
    session: {
      id: session.id,
      float: session.getInt("float"),
      opened_at: iso(session.getString("opened_at")),
    },
    created: opts.created || now(),
    created_by: opts.createdBy,
    vat_registered: settings ? settings.getBool("vat_registered") : false,
    sales: sales,
    tenders: tenders,
    movements: movements,
    trade_ins: tradeIns,
    events: events,
    close: opts.close || null,
  };
}

/** The X or Z report for a session as it stands, through the shared builder. */
function buildReport(app, session, register, opts) {
  return sharedTill().buildTillReport(reportInput(app, session, register, opts));
}

/** Save a built report as its numbered `till_reports` row, in the caller's transaction. */
function saveReport(txApp, register, session, report) {
  var record = new Record(txApp.findCollectionByNameOrId("till_reports"));
  record.set("id", report.id);
  record.set("type", report.type);
  record.set("number", report.number);
  record.set("register", register.id);
  record.set("session", session.id);
  record.set("period_start", report.period_start);
  record.set("period_end", report.period_end);
  record.set("data", report);
  record.set("created_by", report.created_by.id);
  txApp.save(record);
  return record;
}

/** The stored `TillReport`, its id taken from the row. */
function reportOf(record) {
  var data = vaultutil().jsonField(record, "data", null) || {};
  data.id = record.id;
  return data;
}

/** One row of `GET /api/vault/till/reports` (`TillReportSummary`). */
function summaryOf(app, record, cache) {
  var data = reportOf(record);
  var registerId = record.getString("register");
  var registerKey = "register:" + registerId;
  if (cache[registerKey] === undefined) {
    var name = "";
    try {
      name = app.findRecordById("registers", registerId).getString("name");
    } catch (err) {
      name = "";
    }
    cache[registerKey] = name;
  }
  var sales = data.sales || {};
  var cash = data.cash || {};
  var card = data.card || {};
  return {
    id: record.id,
    type: record.getString("type"),
    number: record.getInt("number"),
    register_name: cache[registerKey],
    created: iso(record.getString("created")),
    created_by_name: staffRef(app, record.getString("created_by"), cache).name,
    net: typeof sales.net === "number" ? sales.net : 0,
    cash_variance: typeof cash.variance === "number" ? cash.variance : null,
    card_variance: typeof card.variance === "number" ? card.variance : null,
  };
}

/** Whether the session took or gave back anything on a card. */
function tookCard(app, sessionId) {
  var found = rows(
    app,
    "sale_tenders",
    "session = {:s} && (method = 'card_tide' || method = 'card_other') && amount != 0",
    "",
    { s: sessionId }
  );
  return found.length > 0;
}

/** How many tickets are parked on a register. A failed count throws, so it never reads as none. */
function parkedCount(app, registerId) {
  return app.countRecords("parked_tickets", $dbx.hashExp({ register: registerId }));
}

/** `settings.epos.z_requires_card_total`, on unless an admin switched it off. */
function zRequiresCardTotal(app) {
  var util = vaultutil();
  var row = util.settings(app);
  var epos = row ? util.jsonField(row, "epos", null) : null;
  return !(epos && epos.z_requires_card_total === false);
}

/** A `cash_movements` row as the movement route answers with it. */
function movementShape(app, movement, registerId, cache) {
  return {
    id: movement.id,
    session: movement.getString("session"),
    register: registerId,
    type: movement.getString("type"),
    amount: movement.getInt("amount"),
    reason: movement.getString("reason"),
    staff: staffRef(app, movement.getString("staff"), cache),
    approver: optionalStaffRef(app, movement.getString("approver"), cache),
    created: iso(movement.getString("created")),
  };
}

/** A `till_events` row as the no-sale and void routes answer with it. */
function eventShape(app, event, cache) {
  return {
    id: event.id,
    register: event.getString("register"),
    session: event.getString("session"),
    kind: event.getString("kind"),
    amount: event.getInt("amount"),
    detail: vaultutil().jsonField(event, "detail", null),
    staff: staffRef(app, event.getString("staff"), cache),
    approver: optionalStaffRef(app, event.getString("approver"), cache),
    created: iso(event.getString("created")),
  };
}

/** `{ id, status }` for whatever the printing package hands back, or null. */
function printJobShape(job) {
  if (!job || !job.id) return null;
  var status = typeof job.getString === "function" ? job.getString("status") : job.status;
  return { id: String(job.id), status: String(status || "") };
}

var APPROVAL_USED = "That approval has already been used. Ask for it again.";

/**
 * Mark a grant's override used inside the caller's transaction
 * (lib/permissions.js `consume`). Returns null, or the 409 halt to carry
 * out of the transaction when a concurrent request spent it first.
 */
function consume(txApp, grant, usedFor) {
  var perms = require(__hooks + "/lib/permissions.js");
  try {
    perms.consume(txApp, grant, usedFor);
    return null;
  } catch (err) {
    return { status: 409, message: APPROVAL_USED };
  }
}

/**
 * A read approved by an override still spends it: an override is single use
 * whatever it approves (section 2). A read has no transaction of its own, so
 * this opens one for the approval and its `override` till event. Returns
 * null, or a { status, message } refusal.
 */
function consumeForRead(app, grant, ctx) {
  if (!grant || !grant.override) return null;
  var perms = require(__hooks + "/lib/permissions.js");
  var halt = null;
  try {
    app.runInTransaction(function (txApp) {
      halt = consume(txApp, grant, ctx.used_for);
      if (halt) throw new Error(halt.message);
      perms.logOverrides(txApp, grant, ctx);
    });
  } catch (err) {
    return halt || { status: 409, message: APPROVAL_USED };
  }
  return null;
}

/**
 * Open the register's drawer through its receipt printer (section 6), once
 * the action's own transaction has committed. lib/printing.js belongs to the
 * printing package and may not be installed yet, and a printer that cannot
 * be reached must never undo a movement that has already happened, so any
 * failure is null: the counter then says to open the drawer with the key.
 */
function kickDrawer(app, registerId, staffId, ref) {
  var job = null;
  try {
    var printing = require(__hooks + "/lib/printing.js");
    job = printing.queueDrawerKick(app, { register: registerId, staff: staffId, ref: ref });
  } catch (err) {
    job = null;
  }
  return printJobShape(job);
}

module.exports = {
  NOT_OPEN: NOT_OPEN,
  iso: iso,
  now: now,
  newId: newId,
  query: query,
  plain: plain,
  pence: pence,
  drawerMessage: drawerMessage,
  isUniqueViolation: isUniqueViolation,
  registerFor: registerFor,
  openSession: openSession,
  registerRef: registerRef,
  staffRef: staffRef,
  sessionShape: sessionShape,
  reportInput: reportInput,
  buildReport: buildReport,
  saveReport: saveReport,
  reportOf: reportOf,
  summaryOf: summaryOf,
  tookCard: tookCard,
  parkedCount: parkedCount,
  zRequiresCardTotal: zRequiresCardTotal,
  movementShape: movementShape,
  eventShape: eventShape,
  printJobShape: printJobShape,
  consume: consume,
  consumeForRead: consumeForRead,
  kickDrawer: kickDrawer,
};
