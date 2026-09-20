/**
 * What each sale line was actually paid, from immutable as-sold figures.
 *
 * `sale_lines.qty` and `.discount` are written once at sale completion and
 * never rewritten; a refund only ever moves `sale_lines.refunded_qty` and
 * `sales.refunded_total`. Everything here therefore reads the same numbers
 * whatever has been refunded so far, which is what makes a sequence of
 * partial refunds add up to exactly what was taken for the sale.
 *
 * The arithmetic, in one place because the refund route and the stock book
 * export both need it and must agree to the penny:
 *
 *   lineGross = unit_price * qty - discount
 *   allocation = the line's pro rata share of sales.discount, rounded
 *                half-up, with the LAST line (by created, then id) taking
 *                whatever is left so the allocations sum to sales.discount
 *                exactly
 *   lineNet   = lineGross - allocation          (sum of lineNet = sales.total)
 *   cumNet(n) = roundHalfUp(lineNet * n / qty)  (cumNet(qty) = lineNet)
 *
 * The amount due for refunding `r` more units of a line that already has
 * `refunded_qty` back is cumNet(refunded_qty + r) - cumNet(refunded_qty),
 * so every unit of every line is paid back once and only once.
 *
 * Ordering is "created,id" rather than "created" alone: lines written in
 * one transaction can share a `created` timestamp to the millisecond, and
 * the allocation has to land on the same line every time it is recomputed.
 *
 * require() this from inside each handler, not at file top level - see
 * pb/README.md on pb_hooks isolation.
 */

/** Every sale_line on a sale, in the fixed order the allocation assumes. */
function linesForSale(app, saleId) {
  try {
    return app.findRecordsByFilter("sale_lines", "sale = {:sale}", "created,id", 0, 0, {
      sale: saleId,
    });
  } catch (err) {
    return [];
  }
}

/** unit_price * qty - discount, all as sold. */
function grossOf(line) {
  return line.getInt("unit_price") * Math.max(1, line.getInt("qty")) - line.getInt("discount");
}

/**
 * The as-sold breakdown of one sale.
 *
 * @param {any} app - $app, e.app or a txApp.
 * @param {any} sale - the sales record (for its `discount`).
 * @param {Array<any>} [lines] - the sale's lines, already loaded and ordered.
 * @returns {{lines: Array<any>, byId: object, gross: number, net: number}}
 *   `byId[lineId]` is `{ line, qty, gross, allocation, net }`.
 */
function breakdown(app, sale, lines) {
  var money = require(`${__hooks}/lib/shared/money.js`);

  var rows = lines || linesForSale(app, sale.id);
  var kept = [];
  for (var i = 0; i < rows.length; i++) {
    if (rows[i]) kept.push(rows[i]);
  }

  var gross = 0;
  for (var g = 0; g < kept.length; g++) gross += grossOf(kept[g]);

  var saleDiscount = sale.getInt("discount");
  var byId = {};
  var net = 0;
  var allocated = 0;
  for (var n = 0; n < kept.length; n++) {
    var line = kept[n];
    var lineGross = grossOf(line);
    var allocation = 0;
    if (saleDiscount > 0 && gross > 0) {
      if (n === kept.length - 1) {
        // The last line absorbs the rounding remainder, so the allocations
        // sum to sales.discount exactly.
        allocation = saleDiscount - allocated;
      } else {
        allocation = money.roundHalfUp((saleDiscount * lineGross) / gross);
        allocated += allocation;
      }
    }
    var lineNet = lineGross - allocation;
    net += lineNet;
    byId[line.id] = {
      line: line,
      qty: Math.max(1, line.getInt("qty")),
      gross: lineGross,
      allocation: allocation,
      net: lineNet,
    };
  }

  return { lines: kept, byId: byId, gross: gross, net: net };
}

/**
 * What the first `n` units of a line came to. cumNet(qty) is the line's
 * whole net, so the per-unit amounts always add back up to it.
 */
function cumNet(lineNet, qty, n) {
  var money = require(`${__hooks}/lib/shared/money.js`);
  if (qty <= 0) return 0;
  if (n <= 0) return 0;
  if (n >= qty) return lineNet;
  return money.roundHalfUp((lineNet * n) / qty);
}

/**
 * Points to reverse when a sale's refunded total moves from `before` to
 * `after` pence. Cumulative, so any sequence of partial refunds reverses
 * exactly the points the sale earned and no more.
 */
function pointsCum(pointsEarned, saleTotal, refundedTotal) {
  var money = require(`${__hooks}/lib/shared/money.js`);
  if (saleTotal <= 0 || pointsEarned === 0) return 0;
  if (refundedTotal <= 0) return 0;
  if (refundedTotal >= saleTotal) return pointsEarned;
  return money.roundHalfUp((pointsEarned * refundedTotal) / saleTotal);
}

/**
 * Spread a sale-level discount across per-line gross amounts, pro rata,
 * with the last entry absorbing the remainder. Used by the points earn so
 * the gross the evaluator sees is the amount actually charged.
 *
 * @param {Array<number>} grosses
 * @param {number} discount
 * @returns {Array<number>} the net for each entry, summing to
 *   sum(grosses) - discount.
 */
function spread(grosses, discount) {
  var money = require(`${__hooks}/lib/shared/money.js`);
  var total = 0;
  for (var i = 0; i < grosses.length; i++) total += grosses[i];

  var out = [];
  var allocated = 0;
  for (var n = 0; n < grosses.length; n++) {
    var allocation = 0;
    if (discount > 0 && total > 0) {
      if (n === grosses.length - 1) {
        allocation = discount - allocated;
      } else {
        allocation = money.roundHalfUp((discount * grosses[n]) / total);
        allocated += allocation;
      }
    }
    out.push(grosses[n] - allocation);
  }
  return out;
}

module.exports = {
  linesForSale: linesForSale,
  grossOf: grossOf,
  breakdown: breakdown,
  cumNet: cumNet,
  pointsCum: pointsCum,
  spread: spread,
};
