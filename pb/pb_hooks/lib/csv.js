/**
 * lib/csv.js - the one place every Phase 4 export and import route builds
 * or reads a CSV through.
 *
 * Building: row()/cell()/pounds() are thin wrappers over
 * lib/vaultutil.js's own csvRow/csvCell/poundsCell (the formula-injection
 * guard and the integer-pence-to-plain-pounds writer), so every export
 * route in exports.pb.js goes through the one escaping rule rather than
 * hand-rolling it again per route.
 *
 * Reading: parse() is a small RFC 4180 reader (quoted fields, "" for an
 * embedded quote, commas and newlines inside quotes, CRLF or bare LF line
 * endings) and mapRows() resolves a parsed file's header row against a
 * mapping config's own header-name aliases (docs/csv-formats.md) - the
 * same shape imports.pb.js reads from settings.import_mappings, with a
 * seeded default from a migration.
 *
 * queryParam()/dateParam() read a GET route's own query string. They live
 * here, not in lib/vaultutil.js, because every route handler is its own
 * isolated goja context (pb/README.md): a routerAdd handler cannot see a
 * function declared at the top of its own .pb.js file, only one it
 * require()s fresh, and exports.pb.js now registers six such handlers
 * that all need this.
 *
 * require() this from inside each handler body, not at file top level -
 * see pb/README.md.
 */

function row(cells) {
  var util = require(__hooks + "/lib/vaultutil.js");
  return util.csvRow(cells);
}

function cell(value) {
  var util = require(__hooks + "/lib/vaultutil.js");
  return util.csvCell(value);
}

/** Integer pence as a plain pounds figure with two decimals, no symbol - never a float in between. */
function pounds(pence) {
  var util = require(__hooks + "/lib/vaultutil.js");
  return util.poundsCell(pence);
}

/** A GET query parameter as a trimmed string, or "" when absent. */
function queryParam(e, name) {
  try {
    var info = e.requestInfo();
    var v = info && info.query ? info.query[name] : "";
    if (v !== undefined && v !== null && String(v) !== "") return String(v).trim();
  } catch (err) {
    // fall through to the raw URL below
  }
  try {
    var raw = e.request.url.query().get(name);
    return raw ? String(raw).trim() : "";
  } catch (err) {
    return "";
  }
}

/** A YYYY-MM-DD query parameter, or "" when absent or not that shape. */
function dateParam(e, name) {
  var raw = queryParam(e, name);
  return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : "";
}

/**
 * Parse CSV text into an array of rows, each an array of raw string
 * cells. Handles double-quoted fields ("" is an escaped quote inside
 * one), commas and newlines inside quotes, and CRLF or bare LF line
 * endings. A file that ends cleanly on a newline produces no spurious
 * trailing empty row.
 */
function parse(text) {
  var rows = [];
  var current = [];
  var field = "";
  var inQuotes = false;
  var source = text || "";
  var n = source.length;
  var i = 0;

  function endField() {
    current.push(field);
    field = "";
  }
  function endRow() {
    endField();
    rows.push(current);
    current = [];
  }

  while (i < n) {
    var c = source.charAt(i);
    if (inQuotes) {
      if (c === '"') {
        if (source.charAt(i + 1) === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += c;
      i += 1;
      continue;
    }
    if (c === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (c === ",") {
      endField();
      i += 1;
      continue;
    }
    if (c === "\r") {
      i += 1; // swallowed; the \n (or end of file) that follows closes the row
      continue;
    }
    if (c === "\n") {
      endRow();
      i += 1;
      continue;
    }
    field += c;
    i += 1;
  }
  if (field !== "" || current.length > 0) endRow();

  return rows;
}

/**
 * Resolve a parsed file's rows against a mapping config
 * (docs/csv-formats.md: `{ headerRow, columns: { field: [header, ...] } }`,
 * the first alias that is actually present in the header wins per field).
 *
 * Returns `{ records, header, columnIndexByField }`. Each record is a
 * plain object keyed by the mapping's own field names (raw strings, no
 * type conversion - callers parse prices/quantities themselves through
 * the shared money helpers), plus `_row`: the 1-based line number in the
 * source file, so a review screen or an error message can point at the
 * exact row a spreadsheet would show. `columnIndexByField[field]` is -1
 * when that field's header was not found at all, which is how callers
 * detect a file whose header row does not look like this mapping's at
 * all (docs/api-contract.md's "not a CSV we recognise" refusal).
 */
function mapRows(rows, mapping) {
  var headerRowIndex = (mapping.headerRow || 1) - 1;
  var header = rows[headerRowIndex] || [];
  var normalized = [];
  for (var h = 0; h < header.length; h++) {
    normalized.push(String(header[h] || "").trim().toLowerCase());
  }

  var fields = Object.keys(mapping.columns || {});
  var columnIndexByField = {};
  for (var f = 0; f < fields.length; f++) {
    var field = fields[f];
    var aliases = mapping.columns[field] || [];
    var foundAt = -1;
    for (var a = 0; a < aliases.length; a++) {
      var idx = normalized.indexOf(String(aliases[a]).trim().toLowerCase());
      if (idx >= 0) {
        foundAt = idx;
        break;
      }
    }
    columnIndexByField[field] = foundAt;
  }

  var records = [];
  for (var r = headerRowIndex + 1; r < rows.length; r++) {
    var raw = rows[r];
    if (!raw || raw.length === 0 || (raw.length === 1 && raw[0] === "")) continue; // blank line
    var record = { _row: r + 1 };
    for (var k = 0; k < fields.length; k++) {
      var colIdx = columnIndexByField[fields[k]];
      record[fields[k]] = colIdx >= 0 && colIdx < raw.length ? raw[colIdx] : "";
    }
    records.push(record);
  }

  return { records: records, header: header, columnIndexByField: columnIndexByField };
}

/** True when at least one of the mapping's fields resolved to a real column. */
function looksRecognised(mapped) {
  var fields = Object.keys(mapped.columnIndexByField || {});
  for (var i = 0; i < fields.length; i++) {
    if (mapped.columnIndexByField[fields[i]] >= 0) return true;
  }
  return false;
}

module.exports = {
  row: row,
  cell: cell,
  pounds: pounds,
  queryParam: queryParam,
  dateParam: dateParam,
  parse: parse,
  mapRows: mapRows,
  looksRecognised: looksRecognised,
};
