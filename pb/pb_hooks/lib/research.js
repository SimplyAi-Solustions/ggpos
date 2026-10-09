/**
 * Research requests (docs/api-contract-launch.md, section 5): a staff member
 * or an agent asks for UK sold comps on a card, a retro title, a stock item,
 * a trade-in line or some plain search words; an agent (or a person) claims
 * it and completes it with what sold.
 *
 * Completing writes every comp as a UK sold comp exactly as a staff-entered
 * one is written by `POST /api/vault/cards/{id}/uk-comp` and
 * `/retro/{id}/uk-comp` (prices.pb.js): checked by the same
 * `pricing_policy.validateUkComp`, written by the same
 * `pricing_policy.writeSnapshot` with the same fields, and audited as the
 * same `uk_comp` row. So it leads every other source for 30 days, on the
 * trade-in line, the item page and price check alike.
 *
 * A retro title's completeness (loose, boxed, cib) travels in `finish`, the
 * one column `price_snapshots` files both under.
 *
 * require() this from inside each handler - see pb/README.md on hook
 * isolation.
 */

var STATUSES = ["open", "claimed", "done", "cancelled"];
var COMPLETENESS = ["loose", "boxed", "cib"];
var MAX_COMPS = 20;

var SENTENCES = {
  notFound: "That research request was not found.",
  nothing: "Say what to research: a card, a retro title, an item, a trade-in line or some search words.",
  query: "Keep the search words to 300 characters or fewer.",
  card: "That card was not found. Check the id or search for it again.",
  retro: "That retro title was not found. Check the id or search for it again.",
  item: "That stock item was not found.",
  line: "That trade-in line was not found. Save the line and try again.",
  condition: "Pick a condition: NM, LP, MP, HP or DMG.",
  completeness: "Pick how complete it is: loose, boxed or CIB.",
  finish: "Keep the finish to 60 characters or fewer.",
  status: "Filter by open, claimed, done or cancelled.",
  result: "Keep the result to 2,000 characters or fewer.",
  compsList: "Send the comps as a list.",
  compsMany: "Send 20 comps at most. Keep the closest matches.",
};

function asStr(value) {
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

function findOne(app, collection, id) {
  if (!id) return null;
  try {
    return app.findRecordById(collection, String(id));
  } catch (err) {
    return null;
  }
}

function isoOf(value) {
  var text = String(value || "");
  if (!text) return "";
  var parsed = new Date(text.replace(" ", "T"));
  return isNaN(parsed.getTime()) ? text : parsed.toISOString();
}

/** `{ id, name, kind }` for a staff id, or null. */
function person(app, id) {
  var record = findOne(app, "staff", id);
  if (!record) return null;
  return {
    id: record.id,
    name: record.getString("name"),
    kind: record.getString("kind") === "agent" ? "agent" : "person",
  };
}

/** A card as the words a request is titled and searched by. */
function cardWords(app, card) {
  var set = findOne(app, "card_sets", card.getString("set"));
  return {
    name: card.getString("name"),
    setName: set ? set.getString("name") : "",
    number: card.getString("number"),
  };
}

/** What a request is about, in words: the card, the retro title, the item, or the query. */
function titleFor(app, record) {
  var card = findOne(app, "cards", record.getString("card"));
  if (card) {
    var words = cardWords(app, card);
    return [words.name, words.setName, words.number].filter(Boolean).join(" · ");
  }
  var retro = findOne(app, "retro_titles", record.getString("retro_title"));
  if (retro) return retro.getString("name");
  var item = findOne(app, "items", record.getString("item"));
  if (item && item.getString("title")) return item.getString("title");
  return record.getString("query");
}

function compsOf(record) {
  var raw = null;
  try {
    raw = JSON.parse(toString(record.get("comps")));
  } catch (err) {
    raw = null;
  }
  return Array.isArray(raw) ? raw : [];
}

/** ResearchRequest (packages/shared/src/agents.ts). */
function shape(app, record) {
  var shared = require(__hooks + "/lib/shared/agents.js");
  var query = record.getString("query");
  return {
    id: record.id,
    query: query,
    status: record.getString("status"),
    card: record.getString("card"),
    retro_title: record.getString("retro_title"),
    item: record.getString("item"),
    trade_in_line: record.getString("trade_in_line"),
    condition: record.getString("condition"),
    finish: record.getString("finish"),
    title: titleFor(app, record),
    requested_by: person(app, record.getString("requested_by")),
    claimed_by: person(app, record.getString("claimed_by")),
    claimed_at: isoOf(record.getString("claimed_at")),
    result: record.getString("result"),
    comps: compsOf(record),
    done_at: isoOf(record.getString("done_at")),
    created: isoOf(record.getString("created")),
    updated: isoOf(record.getString("updated")),
    ebay_url: shared.ebaySoldUrl(query),
  };
}

/**
 * What a new request is about, resolved from whichever of trade_in_line,
 * item, retro_title and card it names (the first found wins, and fills in
 * the catalogue row, the finish and the condition from it), plus the search
 * words: the caller's, or worked out from the catalogue row. Returns
 * `{ ok: true, fields }` or `{ ok: false, status, message }`.
 */
function resolve(app, body) {
  var shared = require(__hooks + "/lib/shared/agents.js");
  var policy = require(__hooks + "/adapters/pricing_policy.js");

  var fields = {
    card: "",
    retro_title: "",
    item: "",
    trade_in_line: "",
    condition: asStr(body.condition),
    finish: asStr(body.finish),
  };
  var kind = "";
  var grade = "";
  // A line or an item with no catalogue row behind it is searched by its title.
  var fallbackTitle = "";

  if (body.trade_in_line) {
    var line = findOne(app, "trade_in_lines", asStr(body.trade_in_line));
    if (!line) return { ok: false, status: 404, message: SENTENCES.line };
    fields.trade_in_line = line.id;
    fields.card = line.getString("card");
    fields.retro_title = line.getString("retro_title");
    if (fields.retro_title) {
      if (!fields.finish) fields.finish = line.getString("completeness");
    } else {
      if (!fields.finish) fields.finish = line.getString("finish");
      if (!fields.condition) fields.condition = line.getString("condition");
    }
    kind = line.getString("kind");
    fallbackTitle = line.getString("free_text_title");
  }
  if (body.item) {
    var item = findOne(app, "items", asStr(body.item));
    if (!item) return { ok: false, status: 404, message: SENTENCES.item };
    fields.item = item.id;
    if (!fields.card && !fields.retro_title) {
      fields.card = item.getString("card");
      fields.retro_title = item.getString("retro_title");
    }
    if (fields.retro_title) {
      if (!fields.finish) fields.finish = item.getString("completeness");
    } else {
      if (!fields.finish) fields.finish = item.getString("finish");
      if (!fields.condition) fields.condition = item.getString("condition");
    }
    kind = kind || item.getString("kind");
    fallbackTitle = fallbackTitle || item.getString("title");
    if (item.getString("grade_company") || item.getString("grade")) {
      grade = [item.getString("grade_company"), item.getString("grade")].filter(Boolean).join(" ");
    }
  }
  if (body.retro_title && !fields.card && !fields.retro_title) fields.retro_title = asStr(body.retro_title);
  if (body.card && !fields.card && !fields.retro_title) fields.card = asStr(body.card);

  var name = "";
  var setName = "";
  var number = "";
  if (fields.card) {
    var card = findOne(app, "cards", fields.card);
    if (!card) return { ok: false, status: 404, message: SENTENCES.card };
    var words = cardWords(app, card);
    name = words.name;
    setName = words.setName;
    number = words.number;
    var condition = policy.normalizeCondition(fields.condition);
    if (condition === null) return { ok: false, status: 400, message: SENTENCES.condition };
    fields.condition = condition;
  } else if (fields.retro_title) {
    var retro = findOne(app, "retro_titles", fields.retro_title);
    if (!retro) return { ok: false, status: 404, message: SENTENCES.retro };
    name = retro.getString("name");
    fields.finish = fields.finish.toLowerCase();
    if (fields.finish && COMPLETENESS.indexOf(fields.finish) < 0) {
      return { ok: false, status: 400, message: SENTENCES.completeness };
    }
    fields.condition = "";
    kind = "retro";
  }
  if (fields.finish.length > 60) return { ok: false, status: 400, message: SENTENCES.finish };
  fields.condition = fields.condition.slice(0, 20);

  var query = asStr(body.query).replace(/\s+/g, " ");
  if (query.length > 300) return { ok: false, status: 400, message: SENTENCES.query };
  if (!query && name) {
    query = shared.researchWords({
      name: name,
      setName: setName,
      number: number,
      finish: fields.finish,
      condition: fields.condition,
      kind: kind === "graded" ? "graded" : kind === "retro" ? "retro" : fields.card ? "card" : "other",
      grade: grade,
    });
  }
  if (!query) query = asStr(fallbackTitle).replace(/\s+/g, " ").slice(0, 300);
  if (!query) return { ok: false, status: 400, message: SENTENCES.nothing };
  fields.query = query;
  return { ok: true, fields: fields };
}

/**
 * A live (open or claimed) request about the same thing, so asking twice
 * does not wake an agent twice: the same trade-in line, the same item, or
 * with neither the same catalogue row, finish and condition, or else the
 * same search words.
 */
function liveTwin(app, fields) {
  var filter = "(status = 'open' || status = 'claimed')";
  var params = {};
  if (fields.trade_in_line) {
    filter += " && trade_in_line = {:line}";
    params.line = fields.trade_in_line;
  } else if (fields.item) {
    filter += " && item = {:item}";
    params.item = fields.item;
  } else if (fields.card || fields.retro_title) {
    filter += " && card = {:card} && retro_title = {:retro} && finish = {:finish} && condition = {:condition}";
    filter += " && trade_in_line = '' && item = ''";
    params.card = fields.card;
    params.retro = fields.retro_title;
    params.finish = fields.finish;
    params.condition = fields.condition;
  } else {
    filter += " && card = '' && retro_title = '' && item = '' && trade_in_line = '' && query = {:query}";
    params.query = fields.query;
  }
  try {
    return app.findFirstRecordByFilter("research_requests", filter, params);
  } catch (err) {
    return null;
  }
}

/**
 * The comps a completion sends, checked one by one with the uk-comp
 * routes' own rule and sentences, each prefixed with which comp it is.
 * Returns `{ ok: true, comps }` or `{ ok: false, message }`.
 */
function cleanComps(raw) {
  var util = require(__hooks + "/lib/vaultutil.js");
  var policy = require(__hooks + "/adapters/pricing_policy.js");
  if (raw === undefined || raw === null) return { ok: true, comps: [] };
  if (!Array.isArray(raw)) return { ok: false, message: SENTENCES.compsList };
  if (raw.length > MAX_COMPS) return { ok: false, message: SENTENCES.compsMany };

  // validateUkComp raises its refusal through `e.badRequestError`; this
  // stands in for `e` so each sentence can say which comp it is about.
  var shim = {
    badRequestError: function (message) {
      var err = new Error(message);
      err.ukComp = message;
      return err;
    },
  };

  var comps = [];
  for (var i = 0; i < raw.length; i++) {
    var n = i + 1;
    var comp = raw[i];
    if (!comp || typeof comp !== "object" || Array.isArray(comp)) {
      return { ok: false, message: "Comp " + n + " needs a price, a link and the date it sold." };
    }
    var currency = asStr(comp.currency || "GBP").toUpperCase();
    if (currency !== "GBP") {
      return { ok: false, message: "Comp " + n + " is in " + currency + ". A UK sold comp is in pounds." };
    }
    var price = Number(comp.price);
    if (comp.price === null || comp.price === undefined || comp.price === "" || !isFinite(price) || Math.floor(price) !== price) {
      return {
        ok: false,
        message: "Comp " + n + ": give the price in whole pence, for example 1250 for £12.50.",
      };
    }
    var checked = null;
    try {
      checked = policy.validateUkComp(shim, util, { price: price, url: comp.url, sold_at: comp.sold_at });
    } catch (err) {
      return { ok: false, message: "Comp " + n + ": " + String(err.ukComp || err.message || err) };
    }
    if (checked.url.length > 500) {
      return { ok: false, message: "Comp " + n + ": that link is too long. Paste the listing's own URL." };
    }
    comps.push({
      price: checked.price,
      currency: "GBP",
      sold_at: checked.soldAt,
      url: checked.url,
      title: asStr(comp.title).slice(0, 200),
      condition: asStr(comp.condition).slice(0, 20),
      // Kept for the write; dropped before the comps are stored.
      _soldDate: checked.soldDate,
    });
  }
  return { ok: true, comps: comps };
}

/**
 * Write each comp as a UK sold comp on the request's card or retro title,
 * inside the caller's transaction, exactly as the uk-comp routes do, with
 * the same `uk_comp` audit row. A request about plain search words has
 * nothing to file them under, so they stay on the request alone. Returns
 * how many were written.
 */
function writeComps(txApp, request, comps, actorId, ip) {
  var policy = require(__hooks + "/adapters/pricing_policy.js");
  var auditLib = require(__hooks + "/lib/audit.js");
  var card = request.getString("card");
  var retro = request.getString("retro_title");
  if (!card && !retro) return 0;
  var finish = request.getString("finish");
  var completeness = finish || "loose";
  var written = 0;
  for (var i = 0; i < comps.length; i++) {
    var comp = comps[i];
    var snapshot = policy.writeSnapshot(txApp, {
      card: card || "",
      retroTitle: card ? "" : retro,
      finish: card ? finish : completeness,
      source: "uk_sold_manual",
      nativeCurrency: "GBP",
      nativeLow: comp.price,
      nativeMid: comp.price,
      nativeMarket: comp.price,
      nativeTrend: comp.price,
      fxRate: 1,
      fxDate: comp.sold_at,
      gbpMarket: comp.price,
      fetchedAt: comp._soldDate.toISOString(),
      evidenceUrl: comp.url,
    });
    var meta = card
      ? { card: card, finish: finish, condition: request.getString("condition") || "NM", price: comp.price }
      : { retro_title: retro, completeness: completeness, price: comp.price };
    meta.research = request.id;
    auditLib.writeAuditLog(txApp, {
      actor: actorId,
      action: "uk_comp",
      collection: "price_snapshots",
      record: snapshot.id,
      meta: meta,
      ip: ip,
    });
    written++;
  }
  return written;
}

/** The comps as stored on the request: the shape the contract names. */
function storedComps(comps) {
  var out = [];
  for (var i = 0; i < comps.length; i++) {
    var comp = comps[i];
    out.push({
      price: comp.price,
      currency: comp.currency,
      sold_at: comp.sold_at,
      url: comp.url,
      title: comp.title,
      condition: comp.condition,
    });
  }
  return out;
}

/** The sentence for a request that is no longer where an action needs it. */
function stateRefusal(app, record, action) {
  var status = record.getString("status");
  if (status === "done") return "This request is done. Its comps are in the Research list.";
  if (status === "cancelled") return "This request was cancelled. Ask again if it is still needed.";
  if (status === "claimed" && action !== "cancel") {
    var who = person(app, record.getString("claimed_by"));
    return (who ? who.name : "Somebody else") + " has already claimed this one.";
  }
  return "";
}

module.exports = {
  STATUSES: STATUSES,
  SENTENCES: SENTENCES,
  shape: shape,
  resolve: resolve,
  liveTwin: liveTwin,
  cleanComps: cleanComps,
  writeComps: writeComps,
  storedComps: storedComps,
  stateRefusal: stateRefusal,
};
