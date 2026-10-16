/**
 * Render a report's `table` as CSV, through vaultutil's own formula-
 * injection guard (csvCell/csvRow) so every export in the app quotes a
 * cell that starts with =, +, -, @, a tab or a carriage return the same
 * way the stock book does (pb_hooks/lib/vaultutil.js, pb_hooks/exports.pb.js).
 *
 * require() this from inside each handler that uses it - see
 * pb/README.md on pb_hooks isolation.
 */

/**
 * @param {object} util - pb_hooks/lib/vaultutil.js
 * @param {{key: string, label: string, money?: boolean}[]} columns
 * @param {object[]} rows
 * @returns {string} CSV text, header row first, CRLF line endings.
 */
function renderTable(util, columns, rows) {
  var header = [];
  for (var h = 0; h < columns.length; h++) header.push(columns[h].label);
  var csv = util.csvRow(header);
  for (var r = 0; r < rows.length; r++) {
    var row = rows[r];
    var cells = [];
    for (var c = 0; c < columns.length; c++) {
      var col = columns[c];
      var value = row[col.key];
      if (value === undefined || value === null) value = "";
      cells.push(col.money ? util.poundsCell(value || 0) : value);
    }
    csv += util.csvRow(cells);
  }
  return csv;
}

module.exports = { renderTable: renderTable };
