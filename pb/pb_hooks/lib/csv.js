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
 * embedded quote, commas and newlines inside quotes, CRLF, bare LF or
 * bare CR line endings, a leading UTF-8 BOM stripped) and mapRows()
 * resolves a parsed file's header row against a mapping config's own
 * header-name aliases (docs/csv-formats.md) - the same shape imports.pb.js
 * reads from settings.import_mappings, with a seeded default from a
 * migration.
 *
 * queryParam()/dateParam() read a GET route's own query string.
 * isValidDateStr() checks a real calendar date, not just the YYYY-MM-DD
 * shape - "2026-13-45" is shaped right and still refused. All four live
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

/**
 * True when `s` is a real calendar date, not merely YYYY-MM-DD-shaped -
 * "2026-13-45" matches the shape but is refused here, rather than reaching
 * `new Date(...)` downstream and producing an Invalid Date whose
 * `.toISOString()` throws (the 500 this exists to prevent). Written here
 * rather than reused from `lib/reports/dates.js`'s own `isValidDateStr` -
 * that module belongs to a different package this round.
 */
function isValidDateStr(s) {
  var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || "");
  if (!m) return false;
  var year = Number(m[1]);
  var month = Number(m[2]);
  var day = Number(m[3]);
  if (month < 1 || month > 12) return false;
  if (day < 1) return false;
  var daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return day <= daysInMonth;
}

/** A YYYY-MM-DD query parameter that is a real calendar date, or "" otherwise. */
function dateParam(e, name) {
  var raw = queryParam(e, name);
  return isValidDateStr(raw) ? raw : "";
}

/**
 * Parse CSV text into an array of rows, each an array of raw string
 * cells. Handles double-quoted fields ("" is an escaped quote inside
 * one, and a comma or a newline inside quotes is literal content, not a
 * separator), CRLF, bare LF or bare CR (classic Mac) line endings, and a
 * leading UTF-8 BOM. A file that ends cleanly on a newline produces no
 * spurious trailing empty row.
 *
 * Builds each field from index slices rather than one character at a
 * time: goja turns a `str += char` loop into a fresh string allocation
 * per character (pb/README.md's ID-photo base64 note has the same
 * finding for a different codec), which is unnoticeable on a handful of
 * short cells but real on a file with thousands of rows.
 */
function parse(text) {
  var rows = [];
  var current = [];
  var source = text || "";
  if (source.length && source.charCodeAt(0) === 0xfeff) source = source.slice(1);
  var n = source.length;
  var i = 0;
  var field = ""; // completed chunks of the current field (quoted content, or a prior escaped quote)
  var fieldStart = 0; // start of the pending literal slice not yet folded into `field`
  var inQuotes = false;

  function takeSlice(end) {
    if (end > fieldStart) field += source.slice(fieldStart, end);
  }
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
          takeSlice(i);
          field += '"';
          i += 2;
          fieldStart = i;
          continue;
        }
        takeSlice(i);
        inQuotes = false;
        i += 1;
        fieldStart = i;
        continue;
      }
      i += 1; // literal content (including a comma or a newline) - folded in when the quote closes
      continue;
    }
    if (c === '"') {
      takeSlice(i);
      inQuotes = true;
      i += 1;
      fieldStart = i;
      continue;
    }
    if (c === ",") {
      takeSlice(i);
      endField();
      i += 1;
      fieldStart = i;
      continue;
    }
    if (c === "\r") {
      takeSlice(i);
      if (source.charAt(i + 1) === "\n") {
        i += 1; // swallow the \r; the \n right after ends the row below
        fieldStart = i;
        continue;
      }
      endRow(); // a lone \r (classic Mac) ends the row on its own
      i += 1;
      fieldStart = i;
      continue;
    }
    if (c === "\n") {
      takeSlice(i);
      endRow();
      i += 1;
      fieldStart = i;
      continue;
    }
    i += 1;
  }
  takeSlice(i);
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
 * all (docs/api-contract.md's "not a CSV we recognise" refusal). A line
 * that parses into cells that are all empty (a blank line, or a run of
 * bare commas) is skipped rather than becoming a row a caller might
 * count as a processing failure.
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

  function isBlankRow(raw) {
    if (!raw || raw.length === 0) return true;
    for (var c = 0; c < raw.length; c++) {
      if (String(raw[c] || "").trim() !== "") return false;
    }
    return true;
  }

  var records = [];
  for (var r = headerRowIndex + 1; r < rows.length; r++) {
    var raw = rows[r];
    if (isBlankRow(raw)) continue;
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
  isValidDateStr: isValidDateStr,
  parse: parse,
  mapRows: mapRows,
  looksRecognised: looksRecognised,
};
