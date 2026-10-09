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

    // `branch` is the sales report's category drill-down (by=category); the
    // other reports ignore it.
    const branch = queryParam("branch");
    const params = { from: from, to: to, group: group, by: by, branch: branch };
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
        const prevResult = builder.build(e.app, util, {
          from: prev.from,
          to: prev.to,
          group: group,
          by: by,
          branch: branch,
        });
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

// ---------------------------------------------------------------------
// The dashboard and the VAT return (docs/api-contract-launch.md, section
// 3). Their own paths, so they answer their own shapes rather than the
// report envelope; both need `reports_view`. The builders live in
// lib/reports/dashboard.js and lib/reports/vat.js.
// ---------------------------------------------------------------------

/** GET /api/vault/reports/dashboard?from=&to=&compare=previous */
routerAdd(
  "GET",
  "/api/vault/reports/dashboard",
  (e) => {
    const util = require(`${__hooks}/lib/vaultutil.js`);
    const perms = require(`${__hooks}/lib/permissions.js`);
    const dates = require(`${__hooks}/lib/reports/dates.js`);
    const csvLib = require(`${__hooks}/lib/csv.js`);
    const dashboard = require(`${__hooks}/lib/reports/dashboard.js`);

    const grant = perms.check(e, "reports_view");
    if (!grant.ok) return perms.refuse(e, grant);

    const from = csvLib.queryParam(e, "from");
    const to = csvLib.queryParam(e, "to");
    if (!dates.isValidDateStr(from) || !dates.isValidDateStr(to)) {
      throw e.badRequestError("Pick a date range. Both from and to are needed, as YYYY-MM-DD.", null);
    }
    if (from > to) {
      throw e.badRequestError("The from date is after the to date. Swap them over.", null);
    }
    if (dates.daysBetweenInclusive(from, to) > 400) {
      throw e.badRequestError("Pick a range of up to 400 days.", null);
    }

    return e.json(
      200,
      dashboard.build(e.app, util, { from: from, to: to, compare: csvLib.queryParam(e, "compare") || "none" })
    );
  },
  $apis.requireAuth("staff")
);

/** GET /api/vault/reports/vat?period=2026-Q4 (the quarter today is in when left out) */
routerAdd(
  "GET",
  "/api/vault/reports/vat",
  (e) => {
    const util = require(`${__hooks}/lib/vaultutil.js`);
    const perms = require(`${__hooks}/lib/permissions.js`);
    const csvLib = require(`${__hooks}/lib/csv.js`);
    const vatReport = require(`${__hooks}/lib/reports/vat.js`);

    const grant = perms.check(e, "reports_view");
    if (!grant.ok) return perms.refuse(e, grant);

    const period = csvLib.queryParam(e, "period") || vatReport.currentPeriod(e.app, util);
    const body = vatReport.build(e.app, util, period);
    if (!body) throw e.badRequestError("Pick a quarter, as 2026-Q4.", null);
    return e.json(200, body);
  },
  $apis.requireAuth("staff")
);

/**
 * POST /api/vault/reports/vat/purchases  (settings_manage)
 * { period: "2026-Q4", vat: <pence>, net: <pence> }: the purchase figures
 * for boxes 4 and 7, entered by hand until purchases are recorded. Audited;
 * answers the quarter's return with them in.
 */
routerAdd(
  "POST",
  "/api/vault/reports/vat/purchases",
  (e) => {
    const util = require(`${__hooks}/lib/vaultutil.js`);
    const perms = require(`${__hooks}/lib/permissions.js`);
    const auditLib = require(`${__hooks}/lib/audit.js`);
    const vatReport = require(`${__hooks}/lib/reports/vat.js`);
    const vatreturn = require(`${__hooks}/lib/shared/vatreturn.js`);

    const grant = perms.check(e, "settings_manage");
    if (!grant.ok) return perms.refuse(e, grant);

    const body = util.body(e);
    const period = util.asStr(body.period);
    const quarter = vatreturn.vatQuarter(period, vatReport.vatSettings(e.app, util).startMonth);
    if (!quarter) throw e.badRequestError("Pick a quarter, as 2026-Q4.", null);

    const figures = { vat: body.vat, net: body.net };
    const keys = ["vat", "net"];
    for (let i = 0; i < keys.length; i++) {
      const value = figures[keys[i]];
      if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 100000000000) {
        throw e.badRequestError("Enter the purchase figures in pence, as whole numbers of 0 or more.", null);
      }
    }

    e.app.runInTransaction((txApp) => {
      vatReport.savePurchases(txApp, quarter.period, figures, grant.by);
      auditLib.writeAuditLog(txApp, {
        actor: grant.by.id,
        action: "vat_purchases",
        collection: "settings",
        record: "",
        meta: { period: quarter.period, vat: figures.vat, net: figures.net },
        ip: e.realIP(),
      });
    });
    return e.json(200, vatReport.build(e.app, util, quarter.period));
  },
  $apis.requireAuth("staff")
);
