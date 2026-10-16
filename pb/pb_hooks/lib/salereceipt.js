/**
 * Sale and refund receipts (docs/api-contract-epos.md, section 4,
 * "Receipts data"): one `ReceiptData` (packages/shared/src/epos-types.ts)
 * for the printed receipt, the browser print page and the email, built once
 * here so the three can never drift.
 *
 * - `build(app, sale, opts)` returns `{ receipt }`, or `{ status, message }`
 *   for a refund reference that is not on the sale.
 * - `render(receipt)` turns that same object into the plain-text and HTML
 *   email bodies.
 * - `normaliseNumber`, `describeLines`, `registerName`, `staffName` and
 *   `isoDate` are shared with the sale lookup (sales.pb.js).
 *
 * Signs: a sale receipt's money is positive. On a refund receipt every
 * amount except a line's `unit_price` and `qty` is negative (money going
 * back), so on both kinds `subtotal - discount = total = sum of the line
 * totals of the receipt's own kind` and the tenders add up to the total.
 *
 * A refund's own lines and quantities are read from its `sale_refund` audit
 * row (`meta.ref`, `meta.lines`), the one place they are recorded: the
 * schema keeps only each line's running `refunded_qty`.
 *
 * A sale taken in the same ticket as a part-exchange or an exchange
 * (docs/api-contract-epos.md, section 7) also lists, after its own lines,
 * the lines brought back (`kind: "return"`, from the refund its audit row
 * names) and the lines traded in (`kind: "trade"`, from its trade-in), each
 * with a negative total, and carries the `trade_in` block. Those lines say
 * what paid: they are not part of the sale's subtotal, discount, total, VAT
 * or margin note, which stay the sale's own, and the `part_exchange` and
 * `exchange` tenders are how they paid for it, so the tenders still add up
 * to the total. Their own money is on the trade-in's receipt and the
 * refund's receipt.
 *
 * require() this from inside each handler, not at file top level - see
 * pb/README.md on pb_hooks isolation.
 */

var MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

/** PocketBase's stored date form ("2026-10-09 14:05:00.000Z") as ISO 8601. */
function isoDate(value) {
  if (!value) return "";
  return String(value).replace(" ", "T");
}

/**
 * A typed or scanned receipt number as the sale number it names:
 * "gg-s-456", "GGS000456" (the barcode) and a refund's "GG-S-000456-R1" all
 * give "GG-S-000456". "" when it is not a sale number at all.
 */
function normaliseNumber(typed) {
  var s = String(typed || "")
    .toUpperCase()
    .replace(/\s+/g, "");
  var m = /^GG-?S-?(\d{1,12})(?:-?R\d{1,6})?$/.exec(s);
  if (!m) return "";
  var digits = m[1];
  while (digits.length < 6) digits = "0" + digits;
  return "GG-S-" + digits;
}

/** The barcode form of a number: its dashes taken out. */
function barcodeOf(number) {
  return String(number || "").replace(/-/g, "");
}

/** The first word of a name, for a receipt's "served by". */
function firstName(name) {
  var s = String(name || "").trim();
  if (!s) return "";
  return s.split(/\s+/)[0];
}

function registerName(app, registerId) {
  if (!registerId) return "";
  try {
    return app.findRecordById("registers", registerId).getString("name");
  } catch (err) {
    return "";
  }
}

function staffName(app, staffId) {
  if (!staffId) return "";
  try {
    return app.findRecordById("staff", staffId).getString("name");
  } catch (err) {
    return "";
  }
}

/** Records by id for a list of ids, in one query. */
function byIds(app, collection, ids) {
  var out = {};
  if (!ids.length) return out;
  var rows = [];
  try {
    rows = app.findRecordsByIds(collection, ids);
  } catch (err) {
    rows = [];
  }
  for (var i = 0; i < rows.length; i++) {
    if (rows[i]) out[rows[i].id] = rows[i];
  }
  return out;
}

/** Set, number, condition, finish (and a grade): the short line under an item's title. */
function itemDetail(item) {
  var parts = [];
  var set = item.getString("set_code");
  if (set) parts.push(set.toUpperCase());
  var number = item.getString("number");
  if (number) parts.push(number);
  var grade = [item.getString("grade_company"), item.getString("grade")]
    .filter(function (p) {
      return !!p;
    })
    .join(" ");
  if (grade) parts.push(grade);
  else if (item.getString("condition")) parts.push(item.getString("condition"));
  var finish = item.getString("finish");
  if (finish && finish !== "normal") parts.push(finish);
  return parts.join(" · ");
}

/**
 * What each sale line says about itself: `{ [lineId]: { title, detail, sku } }`.
 * The line's own title wins (a renamed product or an open-price "Single
 * card: Charizard ex" reads as it was sold); lines from before titles were
 * stored fall back to the item or the product.
 */
function describeLines(app, rows) {
  var itemIds = [];
  var productIds = [];
  for (var i = 0; i < rows.length; i++) {
    if (!rows[i]) continue;
    if (rows[i].getString("item")) itemIds.push(rows[i].getString("item"));
    if (rows[i].getString("product")) productIds.push(rows[i].getString("product"));
  }
  var items = byIds(app, "items", itemIds);
  var products = byIds(app, "till_products", productIds);

  var out = {};
  for (var j = 0; j < rows.length; j++) {
    var row = rows[j];
    if (!row) continue;
    var item = items[row.getString("item")] || null;
    var product = products[row.getString("product")] || null;
    var title =
      row.getString("title") ||
      (item ? item.getString("title") || item.getString("sku") : "") ||
      (product ? product.getString("name") : "") ||
      "Item";
    out[row.id] = {
      title: title,
      detail: item ? itemDetail(item) : "",
      sku: item ? item.getString("sku") : "",
    };
  }
  return out;
}

/** The shop block: name, address lines, phone, email and the VAT number when registered. */
function shopOf(settings) {
  if (!settings) {
    return { name: "GG Entertainment", address_lines: [], phone: "", email: "", vat_number: "" };
  }
  var lines = String(settings.getString("shop_address") || "")
    .split(/\r?\n/)
    .map(function (l) {
      return l.trim();
    })
    .filter(function (l) {
      return !!l;
    });
  if (settings.getString("shop_town")) lines.push(settings.getString("shop_town"));
  if (settings.getString("shop_postcode")) lines.push(settings.getString("shop_postcode"));
  return {
    name: settings.getString("shop_name") || "GG Entertainment",
    address_lines: lines,
    phone: settings.getString("shop_phone"),
    email: settings.getString("shop_email"),
    vat_number: settings.getBool("vat_registered") ? settings.getString("vat_number") : "",
  };
}

/** The label for a sale's discount, from where it came. */
function discountLabel(app, sale) {
  var source = sale.getString("discount_source");
  if (source === "reward") {
    try {
      var redemption = app.findFirstRecordByFilter("reward_redemptions", "used_in_sale = {:s}", {
        s: sale.id,
      });
      var reward = app.findRecordById("loyalty_rewards", redemption.getString("reward"));
      return "Reward: " + reward.getString("name");
    } catch (err) {
      return "Reward";
    }
  }
  if (source === "tier_perk") return "Guild discount";
  return "Discount";
}

/** The `sale_refund` audit row for one refund reference, or null. */
function refundAudit(app, sale, ref) {
  var util = require(__hooks + "/lib/vaultutil.js");
  var rows = [];
  try {
    rows = app.findRecordsByFilter(
      "audit_log",
      "action = 'sale_refund' && record = {:id}",
      "created",
      0,
      0,
      { id: sale.id }
    );
  } catch (err) {
    rows = [];
  }
  for (var i = 0; i < rows.length; i++) {
    if (!rows[i]) continue;
    var meta = util.jsonField(rows[i], "meta", {}) || {};
    if (meta.ref === ref) return { row: rows[i], meta: meta };
  }
  return null;
}

/**
 * A trade-in's accepted lines as receipt lines (`kind: "trade"`): the title
 * the buy-in receipt gives them, the condition (and a finish other than
 * normal) under it, the SKU of the stock it became, and a negative total of
 * offer x qty, in the order the trade-in completed them.
 */
function tradeLines(app, tradeInId) {
  var tradeComplete = require(__hooks + "/lib/tradeincomplete.js");
  var rows = [];
  try {
    rows = tradeComplete.acceptedLines(app, tradeInId);
  } catch (err) {
    rows = [];
  }
  var itemIds = [];
  for (var i = 0; i < rows.length; i++) {
    if (rows[i] && rows[i].getString("item")) itemIds.push(rows[i].getString("item"));
  }
  var items = byIds(app, "items", itemIds);

  var out = [];
  for (var j = 0; j < rows.length; j++) {
    var line = rows[j];
    if (!line) continue;
    var item = items[line.getString("item")] || null;
    var title = line.getString("free_text_title");
    if (!title && line.getString("card")) {
      try {
        var card = app.findRecordById("cards", line.getString("card"));
        var number = card.getString("number");
        title = number ? card.getString("name") + " #" + number : card.getString("name");
      } catch (err) {
        title = "";
      }
    }
    if (!title && line.getString("retro_title")) {
      try {
        title = app.findRecordById("retro_titles", line.getString("retro_title")).getString("name");
      } catch (err) {
        title = "";
      }
    }
    if (!title && item) title = item.getString("title");
    if (!title) title = "Item";

    var detail = [];
    if (line.getString("condition")) detail.push(line.getString("condition"));
    var finish = line.getString("finish");
    if (finish && finish !== "normal") detail.push(finish);

    var qty = Math.max(1, line.getInt("qty"));
    var offer = line.getInt("offer_price");
    out.push({
      title: title,
      detail: detail.join(" · "),
      sku: item ? item.getString("sku") : "",
      qty: qty,
      unit_price: offer,
      discount: 0,
      total: -(offer * qty),
      vat_rate: 0,
      tax_scheme: "margin",
      kind: "trade",
    });
  }
  return out;
}

/**
 * The `ReceiptData` for a sale, or for one of its refunds.
 * @param {any} app
 * @param {any} sale the `sales` record
 * @param {{ refundRef?: string, settings?: any }} opts
 * @returns {{ receipt: object } | { status: number, message: string }}
 */
function build(app, sale, opts) {
  opts = opts || {};
  var util = require(__hooks + "/lib/vaultutil.js");
  var tendersLib = require(__hooks + "/lib/tenders.js");
  var balances = require(__hooks + "/lib/balances.js");
  var refundLib = require(__hooks + "/lib/salerefund.js");
  var tradeComplete = require(__hooks + "/lib/tradeincomplete.js");
  var saleline = require(__hooks + "/lib/shared/saleline.js");
  var vat = require(__hooks + "/lib/shared/vat.js");

  var settings = opts.settings || util.settings(app);
  var epos = tendersLib.eposSettings(app, settings);
  var refundRef = opts.refundRef ? String(opts.refundRef).trim().toUpperCase() : "";

  var rows = util.saleLineRows(app, sale.id);
  var described = describeLines(app, rows);
  var sold = saleline.breakdown(util.asSoldLines(rows), sale.getInt("discount"));
  var rowsById = {};
  for (var r = 0; r < rows.length; r++) {
    if (rows[r]) rowsById[rows[r].id] = rows[r];
  }

  var lines = [];
  var vatLines = [];
  var subtotal = 0;
  var discount = 0;
  var total = 0;
  var marginScheme = false;
  var refund = null;
  var date = isoDate(sale.getString("occurred_at") || sale.getString("created"));
  var servedBy = sale.getString("staff");
  var pointsEarned = sale.getInt("points_earned");

  /** One receipt line for a sale line, as sold or as refunded. */
  function lineOf(about, row, qty, lineTotal, sign, kind) {
    var unit = row.getInt("unit_price");
    var gross = unit * qty;
    return {
      title: about.title,
      detail: about.detail,
      sku: about.sku,
      qty: qty,
      unit_price: unit,
      discount: sign * (gross - lineTotal),
      total: sign * lineTotal,
      vat_rate: row.getFloat("vat_rate"),
      tax_scheme: row.getString("tax_scheme") || "margin",
      kind: kind,
    };
  }

  function pushLine(row, qty, lineTotal, sign, kind) {
    var about = described[row.id] || { title: "Item", detail: "", sku: "" };
    var built = lineOf(about, row, qty, lineTotal, sign, kind);
    var gross = row.getInt("unit_price") * qty;
    if (built.tax_scheme === "margin") marginScheme = true;
    lines.push(built);
    subtotal += sign * gross;
    discount += sign * (gross - lineTotal);
    total += sign * lineTotal;
    return { scheme: built.tax_scheme, rate: built.vat_rate, gross: sign * lineTotal };
  }

  if (!refundRef) {
    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      if (!row) continue;
      var entry = sold.byId[row.id];
      if (!entry) continue;
      var line = pushLine(row, entry.qty, entry.net, 1, "sale");
      if (line.scheme === "standard" && line.rate > 0) {
        // The VAT stored when it was sold; a line from before VAT was
        // stored is worked out the same way now.
        var stored = row.getInt("vat_amount");
        vatLines.push({
          gross: line.gross,
          rate: line.rate,
          vat: stored || vat.vatInside(line.gross, line.rate),
        });
      }
    }

    // Lines brought back in the same ticket (section 7), as the refund the
    // sale's audit row names returned them, negative and outside the
    // sale's own totals.
    var returns = refundLib.returnsOf(app, sale.id);
    if (returns) {
      var origin = null;
      try {
        origin = app.findRecordById("sales", util.asStr(returns.sale));
      } catch (err) {
        origin = null;
      }
      var backAudit = origin ? refundAudit(app, origin, util.asStr(returns.ref)) : null;
      if (backAudit) {
        var originRows = util.saleLineRows(app, origin.id);
        var originById = {};
        for (var o = 0; o < originRows.length; o++) {
          if (originRows[o]) originById[originRows[o].id] = originRows[o];
        }
        var originAbout = describeLines(app, originRows);
        var backLines = backAudit.meta.lines && backAudit.meta.lines.length ? backAudit.meta.lines : [];
        for (var b = 0; b < backLines.length; b++) {
          var gone = backLines[b] || {};
          var from = originById[gone.sale_line];
          if (!from) continue;
          lines.push(
            lineOf(
              originAbout[from.id] || { title: "Item", detail: "", sku: "" },
              from,
              Math.max(1, util.asInt(gone.qty, 1)),
              util.asInt(gone.amount, 0),
              -1,
              "return"
            )
          );
        }
      }
    }

    // Lines traded in towards this sale (section 7), negative, outside the
    // sale's own totals too.
    if (sale.getString("trade_in")) {
      var traded = tradeLines(app, sale.getString("trade_in"));
      for (var tl = 0; tl < traded.length; tl++) lines.push(traded[tl]);
    }
  } else {
    var found = refundAudit(app, sale, refundRef);
    if (!found) {
      return { status: 404, message: `${refundRef} is not a refund on ${sale.getString("number")}.` };
    }
    var meta = found.meta;
    date = isoDate(found.row.getString("created"));
    servedBy = found.row.getString("actor");
    pointsEarned = -util.asInt(meta.points_reversed, 0);
    var reason = "";
    if (meta.note) {
      try {
        reason = app.findRecordById("notes", meta.note).getString("body");
      } catch (err) {
        reason = "";
      }
    }
    refund = { of_number: sale.getString("number"), reason: reason };

    var refundLines = meta.lines && meta.lines.length ? meta.lines : [];
    for (var k = 0; k < refundLines.length; k++) {
      var back = refundLines[k] || {};
      var source = rowsById[back.sale_line];
      if (!source) continue;
      var amount = util.asInt(back.amount, 0);
      var returned = pushLine(source, Math.max(1, util.asInt(back.qty, 1)), amount, -1, "return");
      if (returned.scheme === "standard" && returned.rate > 0) {
        vatLines.push({
          gross: returned.gross,
          rate: returned.rate,
          vat: vat.vatInside(returned.gross, returned.rate),
        });
      }
    }
  }

  var tenders = tendersLib.tendersFor(app, sale, refundRef);

  var customer = null;
  var customerId = sale.getString("customer");
  if (customerId) {
    try {
      var c = app.findRecordById("customers", customerId);
      customer = {
        code: c.getString("code"),
        first_name: firstName(c.getString("name")),
        points_earned: pointsEarned,
        points_balance: balances.pointsBalance(app, customerId),
        credit_balance: balances.creditBalance(app, customerId),
      };
    } catch (err) {
      customer = null;
    }
  }

  // The part-exchange as the sale's response gave it (`SaleTradeIn`): its
  // value, what it paid towards the sale and the surplus paid out.
  var tradeIn = null;
  if (sale.getString("trade_in")) {
    try {
      tradeIn = tradeComplete.saleBlock(app.findRecordById("trade_ins", sale.getString("trade_in")));
    } catch (err) {
      tradeIn = null;
    }
  }

  var portalUrl = "";
  if (epos.receipt.show_portal_qr) {
    var base = "";
    try {
      base = app.settings().meta.appURL || "";
    } catch (err) {
      base = "";
    }
    portalUrl = base.replace(/\/+$/, "") + "/account";
  }

  var number = refundRef || sale.getString("number");
  return {
    receipt: {
      kind: refundRef ? "refund" : "sale",
      number: number,
      sale_id: sale.id,
      barcode: barcodeOf(number),
      date: date,
      register: registerName(app, sale.getString("register")),
      staff: firstName(staffName(app, servedBy)),
      shop: shopOf(settings),
      customer: customer,
      lines: lines,
      subtotal: subtotal,
      discount: discount,
      discount_label: discount !== 0 ? (refundRef ? "Discount" : discountLabel(app, sale)) : "",
      total: total,
      vat: vat.vatSummary(vatLines),
      margin_scheme: marginScheme,
      tenders: tenders,
      change: refundRef ? 0 : tendersLib.changeOf(tenders),
      refund: refund,
      trade_in: tradeIn,
      header: epos.receipt.header,
      footer: epos.receipt.footer,
      returns_policy: epos.receipt.returns_policy,
      portal_url: portalUrl,
    },
  };
}

/** "s***@example.com": enough to recognise, not enough to read off a screen. */
function maskEmail(email) {
  var s = String(email || "").trim();
  var at = s.indexOf("@");
  if (at < 1) return "***";
  return s.charAt(0) + "***" + s.slice(at);
}

/** Escape a value for an HTML text node or attribute. */
function esc(value) {
  return String(value === null || value === undefined ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** "9 October 2026, 14:05" in the shop's own clock. */
function ukDateTime(iso) {
  if (!iso) return "";
  var d = new Date(iso);
  if (isNaN(d.getTime())) return String(iso);
  var dates = require(__hooks + "/lib/reports/dates.js");
  var local = dates.toLondon(d);
  var hh = String(local.getUTCHours());
  var mm = String(local.getUTCMinutes());
  if (hh.length < 2) hh = "0" + hh;
  if (mm.length < 2) mm = "0" + mm;
  return (
    local.getUTCDate() + " " + MONTHS[local.getUTCMonth()] + " " + local.getUTCFullYear() + ", " + hh + ":" + mm
  );
}

/**
 * The part-exchange's figures for a sale receipt's email: what the trade was
 * worth, what it paid towards the sale, and any surplus paid out. None on a
 * refund's receipt, which is about the money going back.
 */
function tradeSummary(tradeIn, isRefund) {
  if (!tradeIn || isRefund) return [];
  var out = [
    { label: "Trade-in " + tradeIn.number + " worth", amount: tradeIn.value },
    { label: "Towards this sale", amount: tradeIn.applied },
  ];
  if (tradeIn.payout_credit > 0) out.push({ label: "Paid as store credit", amount: tradeIn.payout_credit });
  if (tradeIn.payout_cash > 0) out.push({ label: "Paid in cash", amount: tradeIn.payout_cash });
  return out;
}

/** Subject, plain-text and HTML email bodies from build()'s receipt. */
function render(receipt) {
  var money = require(__hooks + "/lib/shared/money.js");
  var gbp = money.formatGBP;
  var isRefund = receipt.kind === "refund";
  var heading = (isRefund ? "Refund " : "Receipt ") + receipt.number;
  var when = ukDateTime(receipt.date);

  var text = [];
  text.push(receipt.shop.name);
  for (var a = 0; a < receipt.shop.address_lines.length; a++) text.push(receipt.shop.address_lines[a]);
  if (receipt.shop.phone) text.push(receipt.shop.phone);
  if (receipt.shop.email) text.push(receipt.shop.email);
  if (receipt.shop.vat_number) text.push("VAT number " + receipt.shop.vat_number);
  if (receipt.header) text.push("", receipt.header);
  text.push("", heading, when);
  if (receipt.refund) text.push("Refund of " + receipt.refund.of_number);
  if (receipt.staff) text.push("Served by " + receipt.staff);

  // A sale's own lines first; on a ticket with an exchange or a
  // part-exchange, the lines brought back and the lines traded in follow
  // under their own headings (section 7). A refund's lines are all its own.
  var groups = [{ heading: "", lines: [] }];
  var backGroup = { heading: "Brought back", lines: [] };
  var tradeGroup = { heading: "Traded in", lines: [] };
  for (var g = 0; g < receipt.lines.length; g++) {
    var kind = receipt.lines[g].kind;
    if (!isRefund && kind === "return") backGroup.lines.push(receipt.lines[g]);
    else if (!isRefund && kind === "trade") tradeGroup.lines.push(receipt.lines[g]);
    else groups[0].lines.push(receipt.lines[g]);
  }
  if (backGroup.lines.length) groups.push(backGroup);
  if (tradeGroup.lines.length) groups.push(tradeGroup);

  for (var gi = 0; gi < groups.length; gi++) {
    text.push("");
    if (groups[gi].heading) text.push(groups[gi].heading);
    for (var i = 0; i < groups[gi].lines.length; i++) {
      var l = groups[gi].lines[i];
      text.push(l.qty + " x " + l.title + "  " + gbp(l.total));
      if (l.detail) text.push("    " + l.detail);
    }
  }
  text.push("");
  if (receipt.discount !== 0) {
    text.push("Subtotal  " + gbp(receipt.subtotal));
    text.push((receipt.discount_label || "Discount") + "  " + gbp(-receipt.discount));
  }
  text.push("Total  " + gbp(receipt.total));
  for (var v = 0; v < receipt.vat.length; v++) {
    var row = receipt.vat[v];
    text.push("VAT at " + row.rate + "% included  " + gbp(row.vat));
  }
  if (receipt.margin_scheme) text.push("Second-hand goods are sold under the VAT margin scheme.");
  text.push("");
  for (var t = 0; t < receipt.tenders.length; t++) {
    var tender = receipt.tenders[t];
    var card = tender.card_last4 ? " ending " + tender.card_last4 : "";
    text.push(tender.label + card + "  " + gbp(tender.amount));
  }
  if (receipt.change > 0) text.push("Change  " + gbp(receipt.change));
  var tradeRows = tradeSummary(receipt.trade_in, isRefund);
  if (tradeRows.length) {
    text.push("");
    for (var tr = 0; tr < tradeRows.length; tr++) text.push(tradeRows[tr].label + "  " + gbp(tradeRows[tr].amount));
  }
  if (receipt.customer) {
    text.push("");
    text.push("GG Guild " + receipt.customer.code);
    if (receipt.customer.points_earned) {
      text.push("Points " + (isRefund ? "taken back" : "earned") + "  " + Math.abs(receipt.customer.points_earned));
    }
    text.push("Points balance  " + receipt.customer.points_balance);
    if (receipt.customer.credit_balance) text.push("Store credit  " + gbp(receipt.customer.credit_balance));
  }
  if (receipt.returns_policy) text.push("", receipt.returns_policy);
  if (receipt.footer) text.push("", receipt.footer);
  if (receipt.portal_url) text.push("", "Your account: " + receipt.portal_url);

  var muted = "color:#6b6b6b;";
  var rows = "";
  var htmlLines = [];
  for (var hg = 0; hg < groups.length; hg++) {
    if (groups[hg].heading) htmlLines.push({ heading: groups[hg].heading });
    for (var hl = 0; hl < groups[hg].lines.length; hl++) htmlLines.push(groups[hg].lines[hl]);
  }
  for (var j = 0; j < htmlLines.length; j++) {
    var line = htmlLines[j];
    if (line.heading) {
      rows +=
        '<tr><td colspan="3" style="padding:12px 0 2px;font-weight:600;">' + esc(line.heading) + "</td></tr>";
      continue;
    }
    rows +=
      "<tr>" +
      '<td style="padding:6px 12px 6px 0;vertical-align:top;">' +
      esc(line.title) +
      (line.detail ? '<br><span style="' + muted + 'font-size:13px;">' + esc(line.detail) + "</span>" : "") +
      "</td>" +
      '<td style="padding:6px 12px 6px 0;text-align:right;vertical-align:top;">' +
      esc(line.qty) +
      "</td>" +
      '<td style="padding:6px 0;text-align:right;vertical-align:top;white-space:nowrap;">' +
      esc(gbp(line.total)) +
      "</td>" +
      "</tr>";
  }

  function pair(label, value, strong) {
    return (
      '<tr><td style="padding:2px 12px 2px 0;">' +
      esc(label) +
      '</td><td style="padding:2px 0;text-align:right;white-space:nowrap;">' +
      (strong ? "<strong>" + esc(value) + "</strong>" : esc(value)) +
      "</td></tr>"
    );
  }

  var totals = "";
  if (receipt.discount !== 0) {
    totals += pair("Subtotal", gbp(receipt.subtotal), false);
    totals += pair(receipt.discount_label || "Discount", gbp(-receipt.discount), false);
  }
  totals += pair("Total", gbp(receipt.total), true);
  for (var w = 0; w < receipt.vat.length; w++) {
    totals += pair("VAT at " + receipt.vat[w].rate + "% included", gbp(receipt.vat[w].vat), false);
  }
  for (var u = 0; u < receipt.tenders.length; u++) {
    var td = receipt.tenders[u];
    totals += pair(td.label + (td.card_last4 ? " ending " + td.card_last4 : ""), gbp(td.amount), false);
  }
  if (receipt.change > 0) totals += pair("Change", gbp(receipt.change), false);
  for (var tx = 0; tx < tradeRows.length; tx++) {
    totals += pair(tradeRows[tx].label, gbp(tradeRows[tx].amount), false);
  }

  var customerBlock = "";
  if (receipt.customer) {
    customerBlock =
      '<p style="margin:16px 0 0;">GG Guild ' +
      esc(receipt.customer.code) +
      (receipt.customer.points_earned
        ? "<br>Points " +
          (isRefund ? "taken back" : "earned") +
          ": " +
          esc(Math.abs(receipt.customer.points_earned))
        : "") +
      "<br>Points balance: " +
      esc(receipt.customer.points_balance) +
      (receipt.customer.credit_balance ? "<br>Store credit: " + esc(gbp(receipt.customer.credit_balance)) : "") +
      "</p>";
  }

  var html =
    '<div style="font-family:ui-sans-serif,system-ui,sans-serif;font-size:15px;line-height:1.5;color:#161616;max-width:560px;">' +
    '<p style="margin:0 0 4px;font-weight:600;">' +
    esc(receipt.shop.name) +
    "</p>" +
    (receipt.shop.address_lines.length
      ? '<p style="margin:0;' + muted + '">' + receipt.shop.address_lines.map(esc).join("<br>") + "</p>"
      : "") +
    (receipt.shop.vat_number ? '<p style="margin:0;' + muted + '">VAT number ' + esc(receipt.shop.vat_number) + "</p>" : "") +
    (receipt.header ? '<p style="margin:12px 0 0;">' + esc(receipt.header) + "</p>" : "") +
    '<h1 style="font-size:18px;margin:20px 0 4px;">' +
    esc(heading) +
    "</h1>" +
    '<p style="margin:0 0 16px;' +
    muted +
    '">' +
    esc(when) +
    (receipt.refund ? "<br>Refund of " + esc(receipt.refund.of_number) : "") +
    (receipt.staff ? "<br>Served by " + esc(receipt.staff) : "") +
    "</p>" +
    '<table style="border-collapse:collapse;width:100%;margin:0 0 16px;">' +
    "<thead><tr>" +
    '<th style="text-align:left;padding:0 12px 6px 0;border-bottom:1px solid #e3e3e3;">Item</th>' +
    '<th style="text-align:right;padding:0 12px 6px 0;border-bottom:1px solid #e3e3e3;">Qty</th>' +
    '<th style="text-align:right;padding:0 0 6px;border-bottom:1px solid #e3e3e3;">Price</th>' +
    "</tr></thead><tbody>" +
    rows +
    "</tbody></table>" +
    '<table style="border-collapse:collapse;margin:0 0 0 auto;">' +
    totals +
    "</table>" +
    (receipt.margin_scheme
      ? '<p style="margin:12px 0 0;' + muted + 'font-size:13px;">Second-hand goods are sold under the VAT margin scheme.</p>'
      : "") +
    customerBlock +
    (receipt.returns_policy
      ? '<p style="margin:16px 0 0;' + muted + 'font-size:13px;">' + esc(receipt.returns_policy) + "</p>"
      : "") +
    (receipt.footer ? '<p style="margin:16px 0 0;">' + esc(receipt.footer) + "</p>" : "") +
    (receipt.portal_url
      ? '<p style="margin:16px 0 0;"><a href="' + esc(receipt.portal_url) + '">Your account</a></p>'
      : "") +
    "</div>";

  return {
    subject: receipt.shop.name + " " + (isRefund ? "refund " : "receipt ") + receipt.number,
    text: text.join("\n"),
    html: html,
  };
}

module.exports = {
  isoDate: isoDate,
  normaliseNumber: normaliseNumber,
  barcodeOf: barcodeOf,
  firstName: firstName,
  registerName: registerName,
  staffName: staffName,
  describeLines: describeLines,
  build: build,
  render: render,
  maskEmail: maskEmail,
};
