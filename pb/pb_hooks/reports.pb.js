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
    const compliance = require(`${__hooks}/lib/reports/compliance.js`);
    const auditLib = require(`${__hooks}/lib/audit.js`);

    function queryParam(name) {
      let raw = "";
      try {
        const info = e.requestInfo();
        raw = util.asStr(info && info.query ? info.query[name] : "");
      } catch (err) {
        raw = "";
      }
      if (!raw) {
        try {
          raw = util.asStr(e.request.url.query().get(name));
        } catch (err) {
          raw = "";
        }
      }
      return raw;
    }

    const rawKey = util.asStr(e.request.pathValue("key"));
    let wantsCsv = false;
    let key = rawKey;
    if (key.length > 4 && key.slice(-4) === ".csv") {
      wantsCsv = true;
      key = key.slice(0, -4);
    }

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
    if (key === "audit" && wantsCsv) {
      const staff = util.requireAdmin(e);
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

    const builders = registryLib.registry();
    const builder = builders[key];
    if (!builder) {
      throw e.notFoundError(
        "Unknown report. Pick one of sales, buyins, margin, stock, channels, customers, loyalty, cash, compliance.",
        null
      );
    }
    if (registryLib.ADMIN_ONLY_KEYS[key]) util.requireAdmin(e);

    let group = queryParam("group") || "day";
    if (["day", "week", "month"].indexOf(group) < 0) group = "day";
    const by = queryParam("by");
    const compare = queryParam("compare") || "none";

    const params = { from: from, to: to, group: group, by: by };
    const result = builder.build(e.app, util, params);

    let compareBlock = null;
    if (compare === "previous") {
      const prev = dates.previousPeriod(from, to);
      const prevResult = builder.build(e.app, util, { from: prev.from, to: prev.to, group: group, by: by });
      compareBlock = { totals: prevResult.totals, from: prev.from, to: prev.to };
    }

    if (wantsCsv) {
      const csv = csvLib.renderTable(util, result.csvColumns, result.table);
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
