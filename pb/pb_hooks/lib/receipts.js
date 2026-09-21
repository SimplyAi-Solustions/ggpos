/**
 * Buy-in receipts: one shape for the print page and the email, built once
 * here so the two can never drift (docs/api-contract.md, "Receipts").
 *
 * `build` returns the JSON the receipt route serves; `render` turns that
 * same object into the plain-text and HTML email bodies.
 *
 * require() this from inside each handler, not at file top level - see
 * pb/README.md on pb_hooks isolation.
 */

var DEFAULT_TERMS =
  "Items bought outright. We check every item before it goes on sale. " +
  "By signing you confirm the items are yours to sell and that the details above are correct. " +
  "We keep this record, and the seller details on it, for six years.";

/** A UK-style date (20 September 2026) from an ISO timestamp. */
function ukDate(value) {
  if (!value) return "";
  var d = new Date(value);
  if (isNaN(d.getTime())) return String(value);
  var months = [
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
  return d.getUTCDate() + " " + months[d.getUTCMonth()] + " " + d.getUTCFullYear();
}

/** Escape a value for an HTML text node or attribute. */
function esc(value) {
  return String(value === null || value === undefined ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Everything the receipt page and the receipt email need.
 *
 * `fileToken` is a PocketBase file token minted by the caller for the staff
 * member making the request (`e.auth.newFileToken()`); it is appended to the
 * signature URL. trade_ins.signature is a protected file, so without a token
 * that URL is refused. It has to be minted from the auth record rather than
 * from the trade-in: `record.newFileToken()` throws "not an auth collection
 * record" on an ordinary record, which is how the URL came to be served bare.
 * Pass "" when nothing will follow the link, as the email body does.
 */
function build(app, tradeIn, settingsRecord, fileToken) {
  var money = require(`${__hooks}/lib/shared/money.js`);

  var settings = settingsRecord;
  if (!settings) {
    try {
      settings = app.findFirstRecordByFilter("settings", "id != ''");
    } catch (err) {
      settings = null;
    }
  }

  var lines = [];
  try {
    lines = app.findRecordsByFilter(
      "trade_in_lines",
      "trade_in = {:id} && accepted = true",
      "created",
      0,
      0,
      { id: tradeIn.id }
    );
  } catch (err) {
    lines = [];
  }

  var lineOut = [];
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    if (!line) continue;

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
    if (!title) title = "Item";

    var qty = Math.max(1, line.getInt("qty"));
    lineOut.push({
      id: line.id,
      title: title,
      condition: line.getString("condition"),
      finish: line.getString("finish"),
      qty: qty,
      market_price: line.getInt("market_price"),
      offer_price: line.getInt("offer_price"),
      line_total: line.getInt("offer_price") * qty,
      offer_price_display: money.formatGBP(line.getInt("offer_price")),
      line_total_display: money.formatGBP(line.getInt("offer_price") * qty),
    });
  }

  var staffName = "";
  if (tradeIn.getString("staff")) {
    try {
      staffName = app.findRecordById("staff", tradeIn.getString("staff")).getString("name");
    } catch (err) {
      staffName = "";
    }
  }

  // trade_ins.signature is a protected file, so it is served with one of
  // PocketBase's own short-lived file tokens rather than a base64 copy in
  // the payload.
  var signature = null;
  var signatureFile = tradeIn.getString("signature");
  if (signatureFile) {
    var token = fileToken || "";
    signature = {
      file: signatureFile,
      url:
        "/api/files/trade_ins/" +
        tradeIn.id +
        "/" +
        signatureFile +
        (token ? "?token=" + token : ""),
      token: token,
    };
  }

  var payoutCash = tradeIn.getInt("payout_cash");
  var payoutCredit = tradeIn.getInt("payout_credit");

  return {
    shop: {
      name: settings ? settings.getString("shop_name") : "",
      address: settings ? settings.getString("shop_address") : "",
      town: settings ? settings.getString("shop_town") : "",
      postcode: settings ? settings.getString("shop_postcode") : "",
      phone: settings ? settings.getString("shop_phone") : "",
      email: settings ? settings.getString("shop_email") : "",
    },
    trade_in: {
      id: tradeIn.id,
      number: tradeIn.getString("number"),
      status: tradeIn.getString("status"),
      completed_at: tradeIn.getString("completed_at"),
      date_display: ukDate(tradeIn.getString("completed_at") || tradeIn.getString("created")),
      payout_type: tradeIn.getString("payout_type"),
      payout_cash: payoutCash,
      payout_credit: payoutCredit,
      payout_total: payoutCash + payoutCredit,
      payout_cash_display: money.formatGBP(payoutCash),
      payout_credit_display: money.formatGBP(payoutCredit),
      payout_total_display: money.formatGBP(payoutCash + payoutCredit),
      total_market: tradeIn.getInt("total_market"),
      total_offer: tradeIn.getInt("total_offer"),
    },
    seller: {
      name: tradeIn.getString("seller_name"),
      address: tradeIn.getString("seller_address"),
      id_type: tradeIn.getString("seller_id_type"),
      id_last4: tradeIn.getString("seller_id_last4"),
      id_expiry: tradeIn.getString("seller_id_expiry"),
    },
    staff: { id: tradeIn.getString("staff"), name: staffName },
    lines: lineOut,
    signature: signature,
    terms: (settings ? settings.getString("receipt_terms") : "") || DEFAULT_TERMS,
    retention_note:
      "We keep this receipt, and the seller details on it, for six years. " +
      "Any ID photo is deleted on its own shorter schedule.",
  };
}

/** Plain-text and HTML bodies for the receipt email, from build()'s object. */
function render(receipt) {
  var shopLine = [
    receipt.shop.address,
    receipt.shop.town,
    receipt.shop.postcode,
  ]
    .filter(function (part) {
      return !!part;
    })
    .join(", ");
  var shopName = receipt.shop.name || "GG Entertainment";

  var text = [];
  text.push(shopName);
  if (shopLine) text.push(shopLine);
  if (receipt.shop.phone) text.push(receipt.shop.phone);
  if (receipt.shop.email) text.push(receipt.shop.email);
  text.push("");
  text.push("Buy-in receipt " + (receipt.trade_in.number || ""));
  text.push(receipt.trade_in.date_display);
  text.push("");
  if (receipt.seller.name) text.push("Seller: " + receipt.seller.name);
  if (receipt.seller.address) text.push("Address: " + receipt.seller.address);
  text.push("");
  text.push("Items");
  for (var i = 0; i < receipt.lines.length; i++) {
    var line = receipt.lines[i];
    var condition = line.condition ? " (" + line.condition + ")" : "";
    text.push(
      "  " + line.qty + " x " + line.title + condition + "  " + line.line_total_display
    );
  }
  text.push("");
  if (receipt.trade_in.payout_cash > 0) {
    text.push("Cash paid: " + receipt.trade_in.payout_cash_display);
  }
  if (receipt.trade_in.payout_credit > 0) {
    text.push("Store credit added: " + receipt.trade_in.payout_credit_display);
  }
  text.push("Total: " + receipt.trade_in.payout_total_display);
  text.push("");
  text.push(receipt.terms);
  text.push("");
  text.push(receipt.retention_note);
  if (receipt.staff.name) {
    text.push("");
    text.push("Served by " + receipt.staff.name + ".");
  }

  var rows = "";
  for (var j = 0; j < receipt.lines.length; j++) {
    var l = receipt.lines[j];
    rows +=
      "<tr>" +
      '<td style="padding:6px 12px 6px 0;">' +
      esc(l.title) +
      (l.condition ? ' <span style="color:#6b6b6b;">' + esc(l.condition) + "</span>" : "") +
      "</td>" +
      '<td style="padding:6px 12px 6px 0;text-align:right;">' +
      esc(l.qty) +
      "</td>" +
      '<td style="padding:6px 0;text-align:right;">' +
      esc(l.line_total_display) +
      "</td>" +
      "</tr>";
  }

  var payoutRows = "";
  if (receipt.trade_in.payout_cash > 0) {
    payoutRows +=
      "<p style=\"margin:0;\">Cash paid: <strong>" +
      esc(receipt.trade_in.payout_cash_display) +
      "</strong></p>";
  }
  if (receipt.trade_in.payout_credit > 0) {
    payoutRows +=
      "<p style=\"margin:0;\">Store credit added: <strong>" +
      esc(receipt.trade_in.payout_credit_display) +
      "</strong></p>";
  }

  var html =
    '<div style="font-family:ui-sans-serif,system-ui,sans-serif;font-size:15px;line-height:1.5;color:#161616;max-width:640px;">' +
    "<p style=\"margin:0 0 4px;font-weight:600;\">" +
    esc(shopName) +
    "</p>" +
    (shopLine ? '<p style="margin:0;color:#6b6b6b;">' + esc(shopLine) + "</p>" : "") +
    '<h1 style="font-size:18px;margin:20px 0 4px;">Buy-in receipt ' +
    esc(receipt.trade_in.number || "") +
    "</h1>" +
    '<p style="margin:0 0 16px;color:#6b6b6b;">' +
    esc(receipt.trade_in.date_display) +
    "</p>" +
    (receipt.seller.name
      ? '<p style="margin:0 0 16px;">' +
        esc(receipt.seller.name) +
        (receipt.seller.address ? "<br>" + esc(receipt.seller.address) : "") +
        "</p>"
      : "") +
    '<table style="border-collapse:collapse;width:100%;margin:0 0 16px;">' +
    "<thead><tr>" +
    '<th style="text-align:left;padding:0 12px 6px 0;border-bottom:1px solid #e3e3e3;">Item</th>' +
    '<th style="text-align:right;padding:0 12px 6px 0;border-bottom:1px solid #e3e3e3;">Qty</th>' +
    '<th style="text-align:right;padding:0 0 6px;border-bottom:1px solid #e3e3e3;">Offer</th>' +
    "</tr></thead><tbody>" +
    rows +
    "</tbody></table>" +
    payoutRows +
    '<p style="margin:8px 0 20px;">Total: <strong>' +
    esc(receipt.trade_in.payout_total_display) +
    "</strong></p>" +
    '<p style="margin:0 0 12px;color:#6b6b6b;font-size:13px;">' +
    esc(receipt.terms) +
    "</p>" +
    '<p style="margin:0;color:#6b6b6b;font-size:13px;">' +
    esc(receipt.retention_note) +
    "</p>" +
    "</div>";

  return { text: text.join("\n"), html: html };
}

module.exports = { build: build, render: render, ukDate: ukDate, DEFAULT_TERMS: DEFAULT_TERMS };
