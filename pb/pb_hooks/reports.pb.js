/// <reference path="../pb_data/types.d.ts" />

/**
 * reports.pb.js - GET /api/vault/reports/:key  (staff; compliance and
 * audit.csv are admin only)
 *
 * The nine reports from docs/PLAN.md's "Reporting" table, all served from
 * one route: ?from=YYYY-MM-DD&to=YYYY-MM-DD&group=day|week|month
 * &by=<dimension>&compare=previous|none. A key ending ".csv" (or the
 * special "audit.csv") renders the same report as a CSV of its table
 * instead of JSON, `Content-Disposition: attachment`, guarded against
 * spreadsheet formula injection the same way the stock book export is
 * (pb_hooks/lib/vaultutil.js's csvCell). See docs/api-contract.md's Phase 4
 * section for every key, dimension, response shape and refusal.
 *
 * Every real builder lives in pb_hooks/lib/reports/*.js; this file only
 * validates the request and wires it to the right one, keeping the handler
 * itself small (pb/README.md, CLAUDE.md's "Hooks").
 *
 * The handler runs in its own isolated goja context, so every require()
 * lives inside it - see pb/README.md.
 */
routerAdd(
  "GET",
  "/api/vault/reports/{key}",
  (e) => {
    const util = require(`${__hooks}/lib/vaultutil.js`);
    const dates = require(`${__hooks}/lib/reports/dates.js`);
    const registryLib = require(`${__hooks}/lib/reports/registry.js`);
    const csvLib = require(`${__hooks}/lib/reports/csv.js`);
    // lib/csv.js (the exports/imports package's own file, not this
    // package's lib/reports/csv.js), reused for its queryParam rather than
    // a second local copy of the same two-tier lookup.
    const sharedCsvLib = require(`${__hooks}/lib/csv.js`);
    const compliance = require(`${__hooks}/lib/reports/compliance.js`);
    const auditLib = require(`${__hooks}/lib/audit.js`);

    function queryParam(name) {
      return sharedCsvLib.queryParam(e, name);
    }

    const rawKey = util.asStr(e.request.pathValue("key"));
    let wantsCsv = false;
    let key = rawKey;
    if (key.length > 4 && key.slice(-4) === ".csv") {
      wantsCsv = true;
      key = key.slice(0, -4);
    }

    // --- Resolve the key and gate on admin *before* touching from/to --------
    // A caller who cannot see a report should learn nothing about it, not
    // even whether their date range would have been well formed - so the
    // admin check runs before date validation, not after. hasOwnProperty
    // plus a typeof check on the resolved value (not just `if (!builder)`)
    // keeps a path key like "constructor" or "toString" from resolving to
    // something inherited off Object.prototype instead of a real builder or
    // a clean 404.
    const isAuditCsv = key === "audit" && wantsCsv;
    const builders = registryLib.registry();
    const hasBuilder = Object.prototype.hasOwnProperty.call(builders, key) && typeof builders[key].build === "function";
    const builder = hasBuilder ? builders[key] : null;
    if (!isAuditCsv && !builder) {
      throw e.notFoundError(
        "Unknown report. Pick one of sales, buyins, margin, stock, channels, customers, loyalty, cash, compliance.",
        null
      );
    }
    const needsAdmin = isAuditCsv || (builder && registryLib.ADMIN_ONLY_KEYS[key]);
    const staff = needsAdmin ? util.requireAdmin(e) : e.auth;

    const from = queryParam("from");
    const to = queryParam("to");
    if (!dates.isValidDateStr(from) || !dates.isValidDateStr(to)) {
      throw e.badRequestError("Pick a date range. Both from and to are needed, as YYYY-MM-DD.", null);
    }
    if (from > to) {
      throw e.badRequestError("The from date is after the to date. Swap them over.", null);
    }
    if (dates.daysBetweenInclusive(from, to) > 400) {
      throw e.badRequestError("Pick a range of up to 400 days.", null);
    }

    // --- The audit log export: its own shape, admin only --------------------
    if (isAuditCsv) {
      const rows = compliance.auditCsvRows(e.app, util, { from: from, to: to });
      const csv = csvLib.renderTable(util, compliance.AUDIT_CSV_COLUMNS, rows);
      auditLib.writeAuditLog(e.app, {
        actor: staff.id,
        action: "export_audit_log",
        collection: "audit_log",
        record: "",
        meta: { from: from, to: to, rows: rows.length },
        ip: e.realIP(),
      });
      const header = e.response.header();
      header.set("Content-Disposition", `attachment; filename="audit-${from}-${to}.csv"`);
      header.set("Cache-Control", "no-store");
      return e.blob(200, "text/csv; charset=utf-8", csv);
    }

    let group = queryParam("group") || "day";
    if (["day", "week", "month"].indexOf(group) < 0) group = "day";
    const by = queryParam("by");
    const compare = queryParam("compare") || "none";

    const params = { from: from, to: to, group: group, by: by };
    const result = builder.build(e.app, util, params);

    // --- compare=previous: only the totals keys the builder itself has
    // declared as period-scoped (PERIOD_SCOPED_TOTALS), not the whole
    // totals object. Several reports mix a genuine period sum (this
    // period's revenue) with an "as things stand right now" figure (stock
    // valuation, everything currently on the want list) that a second
    // build() call would only recompute identically or near-identically -
    // showing that as if it were a "previous period" value would be
    // misleading, and for stock.js's full-table scan, pointlessly
    // expensive. A builder whose declared list is empty (or every key of
    // which the current result carries none) skips the second build() call
    // entirely, since there would be nothing period-scoped to show anyway.
    let compareBlock = null;
    if (compare === "previous") {
      const prev = dates.previousPeriod(from, to);
      const periodScoped = builder.PERIOD_SCOPED_TOTALS || {};
      const hasAnyScopedTotal = Object.keys(result.totals || {}).some((k) => periodScoped[k]);
      const scopedTotals = {};
      if (hasAnyScopedTotal) {
        const prevResult = builder.build(e.app, util, { from: prev.from, to: prev.to, group: group, by: by });
        Object.keys(prevResult.totals || {}).forEach((k) => {
          if (periodScoped[k]) scopedTotals[k] = prevResult.totals[k];
        });
      }
      compareBlock = { totals: scopedTotals, from: prev.from, to: prev.to };
    }

    if (wantsCsv) {
      const csv = csvLib.renderTable(util, result.csvColumns, result.table);
      auditLib.writeAuditLog(e.app, {
        actor: staff.id,
        action: "export_report_csv",
        collection: key,
        record: "",
        meta: { from: from, to: to, rows: result.table.length },
        ip: e.realIP(),
      });
      const header = e.response.header();
      header.set("Content-Disposition", `attachment; filename="${key}-${from}-${to}.csv"`);
      header.set("Cache-Control", "no-store");
      return e.blob(200, "text/csv; charset=utf-8", csv);
    }

    return e.json(200, {
      key: key,
      from: from,
      to: to,
      group: group,
      series: result.series,
      table: result.table,
      totals: result.totals,
      compare: compareBlock,
    });
  },
  $apis.requireAuth("staff")
);
